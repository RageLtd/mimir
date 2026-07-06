/**
 * SSE stream types and parsing for OpenAI-compatible responses.
 *
 * This module owns the low-level SSE → parsed-chunk translation only.
 * Tool call accumulation and agent loop logic live in agent.ts.
 */

import { parseJSON } from "@mimir/plugin-core/util";
import { createChildLogger, log as rootLog } from "./utils/log";

const log = createChildLogger(rootLog, "sse-parser");

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
      /**
       * OpenAI-style reasoning delta. Emitted by mimir-server when the
       * underlying model produces extended-thinking output (DeepSeek
       * reasoning, Anthropic via OAI-compat, GPT-5 reasoning, etc.).
       */
      readonly reasoning_content?: string;
      readonly tool_calls?: readonly ToolCallDelta[];
    };
    readonly finish_reason: string | null;
  }[];
  /**
   * Top-level usage object on the final chunk (per OpenAI's
   * `stream_options.include_usage` spec). mimir-server emits this on
   * every streaming response. `context_window` is a non-standard mimir
   * extension carrying the model's max context size — used to populate
   * the editor's progress bar without a separate /v1/models call.
   */
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly context_window?: number;
  };
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
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call_delta"; readonly delta: ToolCallDelta }
  | {
      readonly type: "usage";
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly contextWindow?: number;
    }
  | { readonly type: "finish"; readonly reason: string | null }
  | { readonly type: "error"; readonly error: string }
  | {
      readonly type: "tool_observation";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly result: string;
    };

export const parseSSELine = (line: string) => {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return null;
  try {
    return parseJSON<ChatCompletionChunk>(data);
  } catch (err) {
    log.debug(
      `Failed to parse SSE data: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
};

export const chunkToEvents = (chunk: ChatCompletionChunk) => {
  const events: SSEEvent[] = [];

  for (const choice of chunk.choices) {
    const delta = choice.delta;

    if (delta.content) {
      events.push({ type: "content", text: delta.content });
    }

    if (delta.reasoning_content) {
      events.push({ type: "thinking", text: delta.reasoning_content });
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

  // Mimir extension: server-side tool observations carry both call and result
  // in a single SSE chunk. The delta's mimir_tool_observation field is a
  // non-standard wire format that the ACP parser translates into observe-only
  // tool_call + tool_result events.
  const firstChoice = chunk.choices[0];
  if (firstChoice?.delta && "mimir_tool_observation" in firstChoice.delta) {
    const obs = (firstChoice.delta as Record<string, unknown>)
      .mimir_tool_observation as {
      id: string;
      name: string;
      input: Record<string, unknown>;
      result: string;
    };
    if (obs && typeof obs === "object" && typeof obs.id === "string") {
      events.push({
        type: "tool_observation",
        id: obs.id,
        name: obs.name,
        input: obs.input ?? {},
        result:
          typeof obs.result === "string"
            ? obs.result
            : String(obs.result ?? ""),
      });
    }
  }

  // Top-level usage chunks (empty choices, populated usage) — terminal
  // signal carrying token counts and context window for the just-finished
  // turn. Per OpenAI streaming spec these arrive AFTER the finish chunk
  // and BEFORE [DONE].
  if (chunk.usage) {
    events.push({
      type: "usage",
      promptTokens: chunk.usage.prompt_tokens,
      completionTokens: chunk.usage.completion_tokens,
      contextWindow: chunk.usage.context_window,
    });
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

const initMutable = (delta: ToolCallDelta) => ({
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
) => {
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
export const accumulateToolCallDeltas = (map: Map<number, MutableToolCall>) => {
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
