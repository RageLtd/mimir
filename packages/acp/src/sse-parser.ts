/**
 * SSE stream types and parsing for OpenAI-compatible responses.
 *
 * This module owns the low-level SSE → parsed-chunk translation only.
 * Tool call accumulation and agent loop logic live in agent.ts.
 */

export type ChatCompletionChunk = {
  readonly id: string;
  readonly object: string;
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: {
      readonly role?: string;
      readonly content?: string;
      readonly tool_calls?: readonly ToolCallDelta[];
    };
    readonly finish_reason: string | null;
  }[];
};

export type ToolCallDelta = {
  readonly index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

/** A fully-resolved tool call after accumulation across SSE chunks. */
export type ResolvedToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
};

export type SSEEvent =
  | { readonly type: "content"; readonly text: string }
  | { readonly type: "tool_call_delta"; readonly delta: ToolCallDelta }
  | { readonly type: "finish"; readonly reason: string | null }
  | { readonly type: "error"; readonly error: string };

export const parseSSELine = (line: string): ChatCompletionChunk | null => {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as ChatCompletionChunk;
  } catch {
    return null;
  }
};

export const chunkToEvents = (chunk: ChatCompletionChunk): SSEEvent[] => {
  const events: SSEEvent[] = [];

  for (const choice of chunk.choices) {
    const delta = choice.delta;

    if (delta.content) {
      events.push({ type: "content", text: delta.content });
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        events.push({ type: "tool_call_delta", delta: tc });
      }
    }

    if (choice.finish_reason) {
      events.push({ type: "finish", reason: choice.finish_reason });
    }
  }

  return events;
};

export const iterateSSE = async function* (
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]") {
          return;
        }

        const chunk = parseSSELine(trimmed);
        if (!chunk) continue;

        for (const event of chunkToEvents(chunk)) {
          yield event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
};

// ── Tool call accumulation ──
//
// The accumulator uses a mutable internal type so we can merge deltas
// without casting. The final ResolvedToolCall has readonly fields.

type MutableFunction = {
  name: string;
  arguments: string;
};

export type MutableToolCall = {
  index: number;
  id: string;
  type: "function";
  function: MutableFunction;
};

const initMutable = (delta: ToolCallDelta): MutableToolCall => ({
  index: delta.index,
  id: delta.id ?? "",
  type: delta.type ?? "function",
  function: {
    name: delta.function?.name ?? "",
    arguments: delta.function?.arguments ?? "",
  },
});

/**
 * Merge an incoming tool_call_delta into the accumulator map.
 * The map values are mutable internally so we can merge incrementally.
 */
export const mergeToolCallDelta = (
  acc: Map<number, MutableToolCall>,
  delta: ToolCallDelta,
): void => {
  const idx = delta.index;
  const existing = acc.get(idx);
  if (!existing) {
    acc.set(idx, initMutable(delta));
    return;
  }
  if (delta.id) existing.id = delta.id;
  if (delta.type) existing.type = delta.type;
  if (delta.function) {
    if (delta.function.name) existing.function.name = delta.function.name;
    if (delta.function.arguments)
      existing.function.arguments += delta.function.arguments;
  }
};

/**
 * Freeze the accumulated mutable tool calls into immutable ResolvedToolCall values.
 */
export const accumulateToolCallDeltas = (
  map: Map<number, MutableToolCall>,
): ResolvedToolCall[] => {
  const calls: ResolvedToolCall[] = [];
  for (const [, tc] of map) {
    calls.push({
      id: tc.id || `call_${Date.now()}`,
      type: "function",
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments || "{}",
      },
    });
  }
  return calls;
};
