/**
 * Codex rollout delta — read new lines from the session's rollout JSONL
 * since the last watermark and convert them to AI SDK ModelMessages for
 * local distillation (persist/precompact hooks).
 *
 * Rollout format (verified on codex-cli 0.144.0, fixture at
 * test-fixtures/rollout-basic-session.jsonl): one JSON object per line
 * with `type` ∈ {session_meta, turn_context, world_state, event_msg,
 * response_item}. Only `response_item` carries conversation; its
 * `payload.type` is one of:
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
 * every read line, not just kept conversation. Codex session ids are
 * UUIDs so sharing the state directory with cc-plugin cannot collide.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
} from "@ai-sdk/provider-utils";
import { attemptSync } from "@mimir/plugin-core/result";
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
  /^<recommended_plugins>/,
  /^<permissions instructions>/,
  /^<skills_instructions>/,
  /^<apps_instructions>/,
  /^<turn_aborted>/,
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

// ---------------------------------------------------------------------------
// Public: readDelta
// ---------------------------------------------------------------------------

const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

export const readDelta = async (transcriptPath: string, watermark: number) => {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) {
    log.warn("rollout not found", { transcriptPath });
    return { messages: [] as ModelMessage[], newOffset: watermark };
  }

  const text = await file.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalLines = lines.length;

  if (watermark >= totalLines) {
    return { messages: [] as ModelMessage[], newOffset: totalLines };
  }

  const payloads: RawPayload[] = [];
  for (const line of lines.slice(watermark)) {
    const [parseErr, parsed] = attemptSync(() => JSON.parse(line) as RawLine);
    if (parseErr) {
      log.warn("failed to parse rollout line", {
        error: parseErr.message,
        preview: line.slice(0, 120),
      });
      continue;
    }
    if (parsed.type !== "response_item" || !parsed.payload) continue;
    payloads.push(parsed.payload);
  }

  // Name every tool output across the whole delta first, so an output
  // arriving before its call (shouldn't happen, but cheap to tolerate)
  // still resolves.
  const toolNameById = new Map<string, string>();
  for (const payload of payloads) {
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
  for (const payload of payloads) {
    if (payload.type === "message") {
      messages.push(...messageToModelMessages(payload));
      continue;
    }
    if (payload.type && TOOL_CALL_TYPES.has(payload.type)) {
      const converted = toolCallToModelMessage(payload);
      if (converted) messages.push(converted);
      continue;
    }
    if (payload.type && TOOL_OUTPUT_TYPES.has(payload.type)) {
      const converted = toolOutputToModelMessage(payload, toolNameById);
      if (converted) messages.push(converted);
    }
    // reasoning and unknown payload types are dropped.
  }

  log.debug("delta extracted", {
    transcriptPath,
    watermark,
    newOffset: totalLines,
    responseItems: payloads.length,
    messages: messages.length,
  });

  return { messages, newOffset: totalLines };
};
