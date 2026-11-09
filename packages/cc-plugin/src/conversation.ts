/**
 * The conversation as the hooks module hands it to `persist` and
 * `precompact`: the messages since the last distillation, in Messages-API
 * form (`$.session.messages({ as: "api" })`, media already stripped),
 * converted here to the AI SDK ModelMessage shape the brain reads.
 *
 * The module owns the watermark (an anchor in `$.state`); the binary sees
 * one delta per run and answers `{ advance }` on stdout — true once the
 * delta is settled, false when the next run should carry it again. With no
 * extraction endpoint configured a run is two-phase (MIM-134): phase one
 * answers `{ advance: false, requests }`, the module completes them on the
 * session's model, and phase two receives them back as `completions`.
 *
 * Conversion:
 *   - text blocks → text; thinking blocks dropped; other kinds dropped.
 *   - tool_use → tool-call; tool_result → a role:"tool" message, the tool's
 *     name recovered from the delta's own tool_use blocks (a result whose
 *     call fell before the delta is named "unknown" rather than lost).
 *   - user text that is Claude Code's slash-command scaffolding
 *     (`<command-name>` and kin) is dropped: no developer wrote it.
 */

import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
} from "@ai-sdk/provider-utils";
import type { CompletionRequest } from "@mimir/plugin-core/brain/extract";
import { attempt } from "@mimir/plugin-core/result";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
};
type Block =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

export type ApiMessage = {
  readonly role: "user" | "assistant";
  readonly content: readonly Block[];
};

/** What the host's model answered for one request: its text, or why not. */
export type Completion = { readonly text: string } | { readonly error: string };
export type Completions = Readonly<Record<string, Completion>>;

export type DistillInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly trigger?: string;
  readonly messages?: readonly ApiMessage[];
  /**
   * Set by a module that can run `requests` on the session's model. The
   * binary updates independently of the pinned plugin, so an older module
   * omits it — and must never be asked for requests it will not answer.
   */
  readonly host_completions?: boolean;
  /** Phase two only: the module's answers to the requests phase one printed. */
  readonly completions?: Completions;
};

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/** The payload on stdin; `{}` when there is none or it is not JSON. */
export const readDistillInput = async () => {
  const raw = await readStdin();
  if (raw.trim().length === 0) return {} as DistillInput;
  // Serialisation boundary: the hooks module wrote this JSON.
  const [err, parsed] = await attempt(
    async () => JSON.parse(raw) as DistillInput,
  );
  return err ? ({} as DistillInput) : parsed;
};

/**
 * What a run prints: whether the module should move its anchor past the
 * delta, plus — phase one only — the completions it should run on the
 * session's model and hand back as `completions` in a second run.
 */
export const answer = (
  advance: boolean,
  requests?: Readonly<Record<string, CompletionRequest>>,
) =>
  process.stdout.write(
    JSON.stringify({ advance, ...(requests ? { requests } : {}) }),
  );

/**
 * One phase-two completion's text, or why there is none. The value came
 * off stdin unvalidated, so its shape is checked here and nothing throws.
 */
export const completionText = (
  completions: Completions | undefined,
  key: string,
) => {
  const completion: unknown = completions?.[key];
  if (completion === undefined) {
    return { ok: false as const, reason: `no ${key} completion returned` };
  }
  if (typeof completion === "object" && completion !== null) {
    if ("text" in completion && typeof completion.text === "string") {
      return { ok: true as const, text: completion.text };
    }
    if ("error" in completion && typeof completion.error === "string") {
      return {
        ok: false as const,
        reason: `${key} completion failed: ${completion.error}`,
      };
    }
  }
  return {
    ok: false as const,
    reason: `${key} completion is malformed (no string text or error)`,
  };
};

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const META_CONTENT_PATTERNS = [
  /^<local-command-/,
  /^<command-name>/,
  /^<command-message>/,
  /^<command-args>/,
  /^<command-stderr>/,
];

const isText = (block: Block): block is TextBlock =>
  block.type === "text" && typeof block.text === "string";
const isToolUse = (block: Block): block is ToolUseBlock =>
  block.type === "tool_use" && typeof block.id === "string";
const isToolResult = (block: Block): block is ToolResultBlock =>
  block.type === "tool_result" && typeof block.tool_use_id === "string";

const buildToolNameIndex = (messages: readonly ApiMessage[]) => {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (isToolUse(block) && typeof block.name === "string")
        map.set(block.id, block.name);
    }
  }
  return map;
};

const assistantContent = (blocks: readonly Block[]) => {
  const out: AssistantContent = [];
  for (const block of blocks) {
    if (isText(block)) {
      if (block.text.length > 0) out.push({ type: "text", text: block.text });
    } else if (isToolUse(block)) {
      out.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input:
          block.input &&
          typeof block.input === "object" &&
          !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
      });
    }
  }
  return out;
};

const renderToolResultBody = (content: string | unknown[]) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: string; text?: string };
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
};

const toolContent = (
  blocks: readonly Block[],
  toolNameById: Map<string, string>,
) => {
  const out: ToolContent = [];
  for (const block of blocks) {
    if (!isToolResult(block)) continue;
    out.push({
      type: "tool-result",
      toolCallId: block.tool_use_id,
      toolName: toolNameById.get(block.tool_use_id) ?? "unknown",
      output: { type: "text", value: renderToolResultBody(block.content) },
    });
  }
  return out;
};

const userText = (blocks: readonly Block[]) =>
  blocks
    .filter(isText)
    .map((block) => block.text)
    .filter(
      (text) =>
        text.length > 0 && !META_CONTENT_PATTERNS.some((re) => re.test(text)),
    )
    .join("\n");

const toModelMessage = (
  message: ApiMessage,
  toolNameById: Map<string, string>,
) => {
  const out: ModelMessage[] = [];
  if (message.role === "assistant") {
    const content = assistantContent(message.content);
    if (content.length > 0) out.push({ role: "assistant", content });
    return out;
  }
  // A user message carries text, tool results, or both: the results go
  // first as a role:"tool" message, the text as a role:"user" one.
  const tools = toolContent(message.content, toolNameById);
  if (tools.length > 0) out.push({ role: "tool", content: tools });
  const text = userText(message.content);
  if (text.length > 0) out.push({ role: "user", content: text });
  return out;
};

export const toModelMessages = (messages: readonly ApiMessage[]) => {
  const toolNameById = buildToolNameIndex(messages);
  return messages.flatMap((message) => toModelMessage(message, toolNameById));
};
