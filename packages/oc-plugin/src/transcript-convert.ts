/**
 * OpenCode transcript shapes — the narrow V2 context records and client
 * the distillation paths read, and their conversion into the AI SDK's
 * ModelMessage shape that local extraction and summarisation accept.
 */

// ── ModelMessage shape ──
//
// Local extraction accepts the AI SDK's ModelMessage shape.
// We don't import the type from the AI SDK
// directly — the type is purely structural and the import would
// pull @ai-sdk/provider-utils into the published bundle. Defining
// it locally keeps the bundle small and the contract obvious.

type AssistantContent =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantContent[] };

// ── OpenCode SDK types (narrow) ──
//
// V2 context records are readonly discriminated records, not V1
// { info, parts } envelopes. Only the fields extraction consumes live here.

type OpenCodePart =
  | { readonly type: "text" | "reasoning"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly state: {
        readonly input: Readonly<Record<string, unknown>> | string;
      };
    };

export type OpenCodeMessage =
  | { readonly id: string; readonly type: "user"; readonly text: string }
  | {
      readonly id: string;
      readonly type: "assistant";
      readonly content: readonly OpenCodePart[];
    }
  | { readonly id: string; readonly type: string };

// ── OpenCode client shape (narrow) ──
//
// The plugin entry passes ctx directly. V2 returns records directly and
// rejects failed requests, with no data/error response wrapper.

export type TranscriptClient = {
  readonly session: {
    readonly context: (args: {
      readonly sessionID: string;
    }) => Promise<readonly OpenCodeMessage[]>;
  };
};

export type TranscriptLogger = {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
};

/**
 * Convert OpenCode's V2 context record into the AI SDK's
 * ModelMessage. Returns null for auxiliary records and empty turns.
 */
export const convertMessage = (msg: OpenCodeMessage) => {
  if (msg.type === "user" && "text" in msg) {
    const text = msg.text.trim();
    if (text.length === 0) return null;
    const out: ModelMessage = { role: "user", content: text };
    return out;
  }
  if (msg.type === "assistant" && "content" in msg) {
    const content: AssistantContent[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "tool" && typeof part.state.input !== "string") {
        content.push({
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          input: { ...part.state.input },
        });
      }
      // reasoning, files, step markers, retries, compaction, etc.
      // are auxiliary — skip.
    }
    if (content.length === 0) return null;
    const out: ModelMessage = { role: "assistant", content };
    return out;
  }
  // Compaction, idle, system updates, etc. are auxiliary; skip.
  return null;
};

/** The convertible records, converted, in order. */
export const convertMessages = (records: readonly OpenCodeMessage[]) =>
  records.flatMap((record) => {
    const converted = convertMessage(record);
    return converted ? [converted] : [];
  });
