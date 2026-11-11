/**
 * Codex rollout reader — convert the session's rollout JSONL to AI SDK
 * ModelMessages for local distillation (persist/precompact hooks), as
 * either the delta since the extraction watermark (`readDelta`) or the
 * window since the last compaction (`readWindow`).
 *
 * Rollout format (verified on codex-cli 0.144.0, fixture at
 * test-fixtures/rollout-basic-session.jsonl): one JSON object per line
 * with `type` ∈ {session_meta, turn_context, world_state, event_msg,
 * response_item, compacted}.
 *
 * The rollout is append-only across compactions: each compaction appends
 * a top-level `compacted` record (opaque replacement history, no readable
 * summary), then metadata lines, then the new conversation. The window is
 * therefore everything after the last `compacted` record — the whole
 * rollout when there is none.
 *
 * Only `response_item` carries conversation; its `payload.type` is one of:
 *   - "message"                  role developer|user|assistant, content
 *                                parts input_text/output_text
 *   - "function_call"            name + JSON-string arguments + call_id
 *   - "function_call_output"     call_id + output
 *   - "custom_tool_call"         name + raw-string input + call_id
 *   - "custom_tool_call_output"  call_id + output (JSON-encoded parts)
 *   - "reasoning"                dropped
 *
 * Filtering: developer-role messages are Codex harness scaffolding and
 * are dropped wholesale; user-message parts opening with a known
 * scaffolding tag (<environment_context>, <user_instructions>, …) are
 * stripped, and the message dropped when nothing survives.
 *
 * Watermark semantics mirror cc-plugin's transcript-delta: line-offset
 * per session in ~/.mimir/persist-state/<session>.json — advance past
 * every read line, not just kept conversation. The same file carries the
 * precompact summary state. Codex session ids are UUIDs so sharing the
 * state directory with cc-plugin cannot collide.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
} from "@ai-sdk/provider-utils";
import { attempt, attemptSync } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import { createLogger } from "./logger";

const log = createLogger("rollout-delta");

const stateDir = () => join(mimirHome(), "persist-state");
const statePath = (sessionId: string) => join(stateDir(), `${sessionId}.json`);

// User-part text openers that mark Codex harness scaffolding rather than
// developer input. Parts matching these are stripped before conversion.
const META_CONTENT_PATTERNS = [
  /^<environment_context>/,
  /^<user_instructions>/,
  // How 0.144 delivers AGENTS.md ("# AGENTS.md instructions", with " for
  // <path>" when a project has one) — for Mimir, the whole persona, ~25k
  // chars at the head of every session and again after each compaction.
  // Unfiltered it counts as a user turn and is read for facts.
  /^# AGENTS\.md instructions/,
  /^<recommended_plugins>/,
  /^<permissions instructions>/,
  /^<skills_instructions>/,
  /^<apps_instructions>/,
  /^<turn_aborted>/,
];

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

/**
 * One state file per session. `offset` is the extraction watermark;
 * `summarizedThrough` is the rollout line of the last message the stored
 * precompact summary covered, so an unchanged window is not summarised
 * twice, and `summaryId` is that summary's replica row, carried into the
 * next compaction's summary.
 *
 * Each write re-reads the file, merges its own fields and renames a
 * uniquely named temp file over it, so a reader never sees a torn file and
 * a sequential writer keeps the other's fields. Under concurrent writers
 * that is not guaranteed: a writer that read before another's rename
 * carries the older value of the other's field, and the last rename wins.
 */
type StateRecord = {
  offset: number;
  summarizedThrough: number;
  summaryId: string | null;
};

const lineCount = (value: unknown) =>
  typeof value === "number" && value >= 0 && Number.isFinite(value) ? value : 0;

const readState = async (sessionId: string) => {
  const file = Bun.file(statePath(sessionId));
  if (!(await file.exists())) return {};
  const parsed = (await file
    .json()
    .catch(() => null)) as Partial<StateRecord> | null;
  return parsed && typeof parsed === "object" ? parsed : {};
};

/** Merges `fields` into the session's state; absent fields keep their values. */
export const writeState = async (
  sessionId: string,
  fields: Partial<StateRecord>,
) => {
  const path = statePath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  // Read as late as possible: the gap between this read and the rename is
  // where a concurrent writer's field can be lost.
  const current = await readState(sessionId);
  await Bun.write(temp, JSON.stringify({ ...current, ...fields }));
  const [renameErr] = await attempt(() => rename(temp, path));
  if (renameErr) {
    await rm(temp, { force: true });
    throw new Error(
      `persist-state for ${sessionId} not written: ${renameErr.message}`,
    );
  }
};

export const readWatermark = async (sessionId: string) =>
  lineCount((await readState(sessionId)).offset);

export const writeWatermark = (sessionId: string, offset: number) =>
  writeState(sessionId, { offset });

export const readSummaryState = async (sessionId: string) => {
  const state = await readState(sessionId);
  return {
    summarizedThrough: lineCount(state.summarizedThrough),
    summaryId:
      typeof state.summaryId === "string" && state.summaryId.length > 0
        ? state.summaryId
        : null,
  };
};

export const writeSummaryState = (
  sessionId: string,
  state: { readonly summarizedThrough: number; readonly summaryId: string },
) =>
  writeState(sessionId, {
    summarizedThrough: state.summarizedThrough,
    summaryId: state.summaryId,
  });

// ---------------------------------------------------------------------------
// Rollout item shapes (narrow — only the fields we consume)
// ---------------------------------------------------------------------------

type RawContentPart = { type?: string; text?: string };

type RawPayload = {
  type?: string;
  role?: "developer" | "user" | "assistant";
  content?: RawContentPart[];
  name?: string;
  call_id?: string;
  /** function_call: JSON-string arguments. */
  arguments?: string;
  /** custom_tool_call: raw string input (code-mode script or patch doc). */
  input?: string;
  /** *_output: raw string or JSON-encoded content-part array. */
  output?: unknown;
};

type RawLine = {
  type?: string;
  payload?: RawPayload;
};

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const textParts = (content: RawContentPart[] | undefined) =>
  (content ?? []).flatMap((part) => {
    if (part.type !== "input_text" && part.type !== "output_text") return [];
    return typeof part.text === "string" && part.text.length > 0
      ? [part.text]
      : [];
  });

const isScaffolding = (text: string) =>
  META_CONTENT_PATTERNS.some((re) => re.test(text));

/**
 * function_call arguments arrive as a JSON string; custom_tool_call input
 * is an arbitrary string (code-mode script, patch document). Normalise
 * both to a plain object so downstream renderers see one shape.
 */
const toolCallInput = (payload: RawPayload) => {
  if (typeof payload.arguments === "string") {
    const [parseErr, parsed] = attemptSync(
      () => JSON.parse(payload.arguments as string) as unknown,
    );
    if (!parseErr && parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return { raw: payload.arguments };
  }
  if (typeof payload.input === "string") return { input: payload.input };
  return {};
};

const joinPartTexts = (parts: readonly RawContentPart[]) =>
  parts
    .flatMap((part) =>
      typeof part?.text === "string" && part.text.length > 0 ? [part.text] : [],
    )
    .join("\n");

/**
 * Tool outputs arrive as a real content-part array ([{type:"input_text",
 * text}] on 0.144.0), as a plain string, or as a JSON-encoded array
 * inside a string. Extract the readable text from any of the three.
 */
const renderToolOutput = (output: unknown) => {
  if (Array.isArray(output)) return joinPartTexts(output as RawContentPart[]);
  if (typeof output !== "string") return "";
  const [parseErr, parsed] = attemptSync(() => JSON.parse(output) as unknown);
  if (parseErr || !Array.isArray(parsed)) return output;
  const joined = joinPartTexts(parsed as RawContentPart[]);
  return joined.length > 0 ? joined : output;
};

const messageToModelMessages = (payload: RawPayload) => {
  const out: ModelMessage[] = [];

  if (payload.role === "assistant") {
    const texts = textParts(payload.content);
    if (texts.length === 0) return out;
    const content: AssistantContent = texts.map((text) => ({
      type: "text" as const,
      text,
    }));
    out.push({ role: "assistant", content });
    return out;
  }

  if (payload.role === "user") {
    const kept = textParts(payload.content).filter(
      (text) => !isScaffolding(text),
    );
    if (kept.length === 0) return out;
    out.push({ role: "user", content: kept.join("\n") });
  }

  // Developer role and unknown roles are harness scaffolding — dropped.
  return out;
};

const toolCallToModelMessage = (payload: RawPayload): ModelMessage | null => {
  if (!payload.call_id || !payload.name) return null;
  const content: AssistantContent = [
    {
      type: "tool-call",
      toolCallId: payload.call_id,
      toolName: payload.name,
      input: toolCallInput(payload),
    },
  ];
  return { role: "assistant", content };
};

const toolOutputToModelMessage = (
  payload: RawPayload,
  toolNameById: Map<string, string>,
): ModelMessage | null => {
  if (!payload.call_id) return null;
  const content: ToolContent = [
    {
      type: "tool-result",
      toolCallId: payload.call_id,
      // "unknown" beats dropping the result — the brain prefers a typed
      // tool message with an unknown name over a hole in the exchange.
      toolName: toolNameById.get(payload.call_id) ?? "unknown",
      output: { type: "text", value: renderToolOutput(payload.output) },
    },
  ];
  return { role: "tool", content };
};

const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

const payloadToModelMessages = (
  payload: RawPayload,
  toolNameById: Map<string, string>,
) => {
  if (payload.type === "message") return messageToModelMessages(payload);
  if (payload.type && TOOL_CALL_TYPES.has(payload.type)) {
    const converted = toolCallToModelMessage(payload);
    return converted ? [converted] : [];
  }
  if (payload.type && TOOL_OUTPUT_TYPES.has(payload.type)) {
    const converted = toolOutputToModelMessage(payload, toolNameById);
    return converted ? [converted] : [];
  }
  // reasoning and unknown payload types are dropped.
  return [];
};

/** A parsed rollout record and its 1-based line number in the rollout. */
type RolloutRecord = { readonly line: number; readonly raw: RawLine };

const readLines = async (transcriptPath: string) => {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) {
    log.warn("rollout not found", { transcriptPath });
    return null;
  }
  return (await file.text()).split("\n").filter((l) => l.length > 0);
};

const parseRecords = (lines: readonly string[], from: number) =>
  lines.slice(from).flatMap((line, i) => {
    const [parseErr, parsed] = attemptSync(() => JSON.parse(line) as RawLine);
    if (parseErr) {
      log.warn("failed to parse rollout line", {
        error: parseErr.message,
        preview: line.slice(0, 120),
      });
      return [];
    }
    const record: RolloutRecord = { line: from + i + 1, raw: parsed };
    return [record];
  });

/**
 * Convert the conversation in `records`; `lastMessageOffset` is the line
 * of the last record that produced a message (0 when none did).
 */
const convertRecords = (records: readonly RolloutRecord[]) => {
  const items = records.flatMap((record) =>
    record.raw.type === "response_item" && record.raw.payload
      ? [{ line: record.line, payload: record.raw.payload }]
      : [],
  );

  // Name every tool output across the whole range first, so an output
  // arriving before its call (shouldn't happen, but cheap to tolerate)
  // still resolves.
  const toolNameById = new Map<string, string>();
  for (const { payload } of items) {
    if (
      payload.type &&
      TOOL_CALL_TYPES.has(payload.type) &&
      payload.call_id &&
      payload.name
    ) {
      toolNameById.set(payload.call_id, payload.name);
    }
  }

  const messages: ModelMessage[] = [];
  let lastMessageOffset = 0;
  for (const { line, payload } of items) {
    const converted = payloadToModelMessages(payload, toolNameById);
    if (converted.length === 0) continue;
    messages.push(...converted);
    lastMessageOffset = line;
  }
  return { messages, lastMessageOffset, responseItems: items.length };
};

// ---------------------------------------------------------------------------
// Public: readDelta, readWindow
// ---------------------------------------------------------------------------

export const readDelta = async (transcriptPath: string, watermark: number) => {
  const lines = await readLines(transcriptPath);
  if (!lines) return { messages: [] as ModelMessage[], newOffset: watermark };
  const totalLines = lines.length;

  if (watermark >= totalLines) {
    return { messages: [] as ModelMessage[], newOffset: totalLines };
  }

  const { messages, responseItems } = convertRecords(
    parseRecords(lines, watermark),
  );

  log.debug("delta extracted", {
    transcriptPath,
    watermark,
    newOffset: totalLines,
    responseItems,
    messages: messages.length,
  });

  return { messages, newOffset: totalLines };
};

/**
 * The conversation since the last `compacted` record (the whole rollout
 * when there is none). `lastMessageOffset` is the rollout line of the
 * window's last message, so metadata Codex appends afterwards does not
 * make an unchanged window look grown. `firstOffset` is the window's
 * first rollout line: the line after the last `compacted` record, or 1.
 */
export const readWindow = async (transcriptPath: string) => {
  const lines = await readLines(transcriptPath);
  if (!lines) {
    return {
      messages: [] as ModelMessage[],
      lastMessageOffset: 0,
      firstOffset: 1,
    };
  }

  const records = parseRecords(lines, 0);
  const boundary = records.findLastIndex(
    (record) => record.raw.type === "compacted",
  );
  const compactedAt = records[boundary]?.line ?? null;
  const { messages, lastMessageOffset, responseItems } = convertRecords(
    records.slice(boundary + 1),
  );
  const firstOffset = (compactedAt ?? 0) + 1;

  log.debug("window extracted", {
    transcriptPath,
    compactedAt,
    firstOffset,
    lastMessageOffset,
    responseItems,
    messages: messages.length,
  });

  return { messages, lastMessageOffset, firstOffset };
};
