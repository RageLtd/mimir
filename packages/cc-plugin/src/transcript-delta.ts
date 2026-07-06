/**
 * CC transcript delta — read new lines since the last watermark, coalesce
 * streaming chunks, convert to AI SDK ModelMessage shape, and ship to
 * mimir-server's /v1/messages/persist endpoint.
 *
 * Shared by persist-hook (Stop) and precompact-hook (PreCompact). Both
 * read the same JSONL transcript on disk, advance the same per-session
 * watermark, and POST to the same endpoint. The server already does
 * fingerprint dedup on appendTurn, so an overlap between the two hooks
 * costs nothing.
 *
 * Filtering rules (drop these — they're CC UI artifacts, not conversation):
 *   - entries with isMeta: true
 *   - user-string content matching <local-command-*> / <command-name> / etc.
 *   - non user/assistant entry types (attachment, file-history-snapshot,
 *     permission-mode, last-prompt, ai-title, system, ...)
 *
 * Coalescing:
 *   CC writes streaming chunks as separate JSONL lines that share the
 *   same `message.id` — a thinking block on one line, a tool_use on the
 *   next, sometimes more. We group consecutive entries by
 *   `${role}:${message.id ?? uuid}` and merge their content arrays so
 *   the brain sees one ModelMessage per actual assistant turn.
 *
 * Thinking blocks are stripped during conversion (decided in plan).
 * Tool-result entries are mapped to role:"tool" ModelMessages with
 * proper ToolResultPart shape; the toolName is recovered by walking the
 * delta's tool_use blocks first and indexing by tool_use id.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
} from "@ai-sdk/provider-utils";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import { authHeaders, providerByok } from "./config";
import { createLogger } from "./logger";

const log = createLogger("transcript-delta");

const PERSIST_ROUTE = "/v1/messages/persist";

/** BYOK key transport (MIM-74) — header, never body: request bodies get
 *  logged on validation failure server-side; headers don't. */
const PROVIDER_KEY_HEADER = "X-Provider-Api-Key";

const stateDir = () => join(mimirHome(), "persist-state");
const statePath = (sessionId: string) => join(stateDir(), `${sessionId}.json`);

// User-side text content patterns that mark CC slash-command / local-command
// scaffolding. These appear as type:"user" entries but contain no actual
// developer input — the brain shouldn't see them.
const META_CONTENT_PATTERNS = [
  /^<local-command-/,
  /^<command-name>/,
  /^<command-message>/,
  /^<command-args>/,
  /^<command-stderr>/,
];

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

type WatermarkRecord = { offset: number };

export const readWatermark = async (sessionId: string) => {
  const file = Bun.file(statePath(sessionId));
  if (!(await file.exists())) return 0;
  const parsed = (await file
    .json()
    .catch(() => null)) as Partial<WatermarkRecord> | null;
  if (
    parsed &&
    typeof parsed.offset === "number" &&
    parsed.offset >= 0 &&
    Number.isFinite(parsed.offset)
  ) {
    return parsed.offset;
  }
  return 0;
};

export const writeWatermark = async (sessionId: string, offset: number) => {
  await mkdir(dirname(statePath(sessionId)), { recursive: true }).catch(
    () => undefined,
  );
  await Bun.write(statePath(sessionId), JSON.stringify({ offset }));
};

// ---------------------------------------------------------------------------
// Transcript entry shape (narrow — we only touch the fields we care about)
// ---------------------------------------------------------------------------

type RawTextPart = { type: "text"; text: string };
type RawThinkingPart = { type: "thinking"; thinking: string };
type RawToolUsePart = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
type RawToolResultPart = {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
};
type RawContentPart =
  | RawTextPart
  | RawThinkingPart
  | RawToolUsePart
  | RawToolResultPart
  | { type: string; [k: string]: unknown };

type RawEntry = {
  type?: string;
  isMeta?: boolean;
  uuid?: string;
  message?: {
    role?: "user" | "assistant";
    content?: string | RawContentPart[];
    id?: string;
  };
};

const isRealConversation = (entry: RawEntry) => {
  if (entry.type !== "user" && entry.type !== "assistant") return false;
  if (entry.isMeta === true) return false;
  if (!entry.message?.role) return false;

  const content = entry.message.content;
  if (typeof content === "string") {
    return !META_CONTENT_PATTERNS.some((re) => re.test(content));
  }
  if (Array.isArray(content)) return content.length > 0;
  return false;
};

// ---------------------------------------------------------------------------
// Coalescing + conversion
// ---------------------------------------------------------------------------

type Group = { key: string; entries: RawEntry[] };

const groupBySharedMessageId = (entries: readonly RawEntry[]) => {
  const groups: Group[] = [];
  const indexByKey = new Map<string, number>();

  for (const entry of entries) {
    // Key by role + message.id (or uuid fallback). Same message.id across
    // streaming chunks → same group. Different role with the same id
    // (defensive — shouldn't happen) stays separate.
    const id = entry.message?.id ?? entry.uuid ?? "";
    const key = `${entry.type}:${id}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined && key !== `${entry.type}:`) {
      groups[existing]?.entries.push(entry);
    } else {
      indexByKey.set(key, groups.length);
      groups.push({ key, entries: [entry] });
    }
  }
  return groups;
};

const buildToolNameIndex = (entries: readonly RawEntry[]) => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool_use") {
        const id = (part as RawToolUsePart).id;
        const name = (part as RawToolUsePart).name;
        if (id && name) map.set(id, name);
      }
    }
  }
  return map;
};

const flattenContent = (entries: readonly RawEntry[]) => {
  const parts: RawContentPart[] = [];
  for (const entry of entries) {
    const c = entry.message?.content;
    if (typeof c === "string" && c.length > 0) {
      parts.push({ type: "text", text: c });
      continue;
    }
    if (Array.isArray(c)) parts.push(...c);
  }
  return parts;
};

const assistantPartsToAiSdk = (parts: readonly RawContentPart[]) => {
  const out: AssistantContent = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = (part as RawTextPart).text ?? "";
      if (text.length > 0) out.push({ type: "text", text });
      continue;
    }
    if (part.type === "tool_use") {
      const tu = part as RawToolUsePart;
      out.push({
        type: "tool-call",
        toolCallId: tu.id,
        toolName: tu.name,
        input:
          tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
            ? (tu.input as Record<string, unknown>)
            : {},
      });
    }
    // Thinking blocks stripped per plan. Other unknown parts dropped.
  }
  return out;
};

const renderToolResultBody = (content: string | unknown[]) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // The Anthropic tool_result content array can mix text and image parts;
  // we only retain text for the brain (images aren't useful in a summary).
  return content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      const part = p as { type?: string; text?: string };
      return part.type === "text" && typeof part.text === "string"
        ? part.text
        : "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
};

const userPartsToToolMessages = (
  parts: readonly RawContentPart[],
  toolNameById: Map<string, string>,
) => {
  const toolParts: ToolContent = [];
  for (const part of parts) {
    if (part.type !== "tool_result") continue;
    const tr = part as RawToolResultPart;
    const text = renderToolResultBody(tr.content);
    toolParts.push({
      type: "tool-result",
      toolCallId: tr.tool_use_id,
      // Fall back to "unknown" rather than dropping the whole result — the
      // brain prefers a typed tool message with an unknown name over a
      // missing entry.
      toolName: toolNameById.get(tr.tool_use_id) ?? "unknown",
      output: { type: "text", value: text },
    });
  }
  return toolParts;
};

const groupToModelMessages = (
  group: Group,
  toolNameById: Map<string, string>,
) => {
  const out: ModelMessage[] = [];
  const first = group.entries[0];
  if (!first?.message?.role) return out;

  const parts = flattenContent(group.entries);

  if (first.message.role === "assistant") {
    const aiParts = assistantPartsToAiSdk(parts);
    if (aiParts.length === 0) return out;
    out.push({ role: "assistant", content: aiParts });
    return out;
  }

  // role === "user"
  // User entries may carry plain text, tool_result blocks, or a mix.
  // Tool-result content becomes a role:"tool" ModelMessage; plain text
  // becomes a role:"user" ModelMessage. Both can be emitted from one
  // group if CC ever interleaves them (rare but legal).
  const userText = parts
    .flatMap((p) => {
      if (p.type !== "text") return [];
      const text = (p as RawTextPart).text;
      return typeof text === "string" && text.length > 0 ? [text] : [];
    })
    .join("\n");
  const toolParts = userPartsToToolMessages(parts, toolNameById);

  if (toolParts.length > 0) {
    out.push({ role: "tool", content: toolParts });
  }

  if (userText.length > 0) {
    out.push({ role: "user", content: userText });
  }

  return out;
};

// ---------------------------------------------------------------------------
// Public: readDelta + shipDelta
// ---------------------------------------------------------------------------

export const readDelta = async (transcriptPath: string, watermark: number) => {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) {
    log.warn("transcript not found", { transcriptPath });
    return { messages: [] as ModelMessage[], newOffset: watermark };
  }

  const text = await file.text();
  // Split on newlines, keep only non-empty. The total line count drives
  // the new watermark (so we advance past all read lines, not just
  // those we kept as conversation).
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalLines = lines.length;

  if (watermark >= totalLines) {
    return { messages: [] as ModelMessage[], newOffset: totalLines };
  }

  const newLines = lines.slice(watermark);

  const entries: RawEntry[] = [];
  for (const line of newLines) {
    const [parseErr, parsed] = await attempt(
      async () => JSON.parse(line) as RawEntry,
    );
    if (parseErr) {
      log.warn("failed to parse transcript line", {
        error: parseErr.message,
        preview: line.slice(0, 120),
      });
      continue;
    }
    if (isRealConversation(parsed)) entries.push(parsed);
  }

  if (entries.length === 0) {
    return { messages: [] as ModelMessage[], newOffset: totalLines };
  }

  // Build tool-name index across the whole delta first so out-of-order
  // tool_result entries can still resolve a name.
  const toolNameById = buildToolNameIndex(entries);

  const groups = groupBySharedMessageId(entries);

  const messages: ModelMessage[] = [];
  for (const group of groups) {
    const converted = groupToModelMessages(group, toolNameById);
    messages.push(...converted);
  }

  log.debug("delta extracted", {
    transcriptPath,
    watermark,
    newOffset: totalLines,
    newLines: newLines.length,
    entriesAfterFilter: entries.length,
    groups: groups.length,
    messages: messages.length,
  });

  return { messages, newOffset: totalLines };
};

export type ShipResult =
  | { ok: true; appended: number }
  | { ok: false; error: string };

export const shipDelta = async (
  serverUrl: string,
  messages: readonly ModelMessage[],
  project: string,
  projectId?: string | null,
) => {
  if (messages.length === 0) {
    return { ok: true, appended: 0 } as ShipResult;
  }

  const url = `${serverUrl}${PERSIST_ROUTE}`;
  const auth = await authHeaders();
  // BYOK (MIM-74): the extraction this persist spawns runs on the user's
  // provider key when configured. Key in the header; the non-secret
  // provider/small-model hints ride the body.
  const byok = await providerByok();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...auth,
  };
  if (byok) headers[PROVIDER_KEY_HEADER] = byok.apiKey;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages,
      project,
      ...(projectId ? { projectId } : {}),
      ...(byok?.provider ? { provider: byok.provider } : {}),
      ...(byok?.smallModel ? { small_model: byok.smallModel } : {}),
    }),
  }).catch((err) => {
    log.error("persist fetch failed", { url, error: errMessage(err) });
    return null;
  });

  if (!response) return { ok: false, error: "fetch failed" } as ShipResult;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    log.error("persist non-OK", { status: response.status, body });
    return {
      ok: false,
      error: `status ${response.status}`,
    } as ShipResult;
  }

  const payload = (await response.json().catch(() => null)) as {
    appended?: number;
  } | null;
  return { ok: true, appended: payload?.appended ?? 0 } as ShipResult;
};
