/**
 * Server backend adapter.
 *
 * Thin wrapper over the existing streamCompletion + sse-parser pipeline.
 * Translates SSEEvent → BackendEvent so the agent loop can be backend-agnostic.
 *
 * The server backend's tool calls are real requests to be executed by the
 * agent loop, so observeOnly is always false here.
 */

import { createChildLogger, log as rootLog } from "../utils/log";

const log = createChildLogger(rootLog, "server-backend");

import {
  type ChatMessage,
  type ServerClientConfig,
  streamCompletion,
  type ToolDefinition,
} from "../server-client";
import {
  accumulateToolCallDeltas,
  type MutableToolCall,
  mergeToolCallDelta,
  type SSEEvent,
} from "../sse-parser";
import { errMessage } from "../util";
import type { Backend, BackendRunOptions } from "./types";

/**
 * Parse tool-call arguments without try/catch. JSON.parse throws sync;
 * Promise.resolve().then().catch() converts the throw into a fallback
 * value via the rule-approved Result-style pattern.
 */
const parseToolCallArgs = (name: string, raw: string) =>
  Promise.resolve()
    .then(() => {
      const parsed = JSON.parse(raw);
      // Some models (e.g. Kimi K2.6 via Fireworks) emit tool call arguments
      // as a bare string or primitive instead of a JSON object. Upstream APIs
      // reject these on the next turn when the conversation history is
      // re-submitted, so coerce non-objects to an empty object and log it.
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        log.warn(
          `Tool ${name}: arguments decoded to ${typeof parsed}, expected object. Raw: ${raw.slice(0, 200)}`,
        );
        return {} as Record<string, unknown>;
      }
      return parsed as Record<string, unknown>;
    })
    .catch((err) => {
      log.debug(
        `Failed to parse tool call arguments for ${name}:`,
        err instanceof Error ? err.message : String(err),
      );
      return {} as Record<string, unknown>;
    });

export const createServerBackend = (serverConfig: ServerClientConfig) => {
  const run = async function* (options: BackendRunOptions) {
    const acc = new Map<number, MutableToolCall>();
    // Buffered usage from the trailing usage chunk (per OpenAI
    // include_usage spec, arrives AFTER the choice's finish_reason).
    // mimir-server emits both for every streaming response, so we hold
    // the finish event until the usage chunk arrives and then emit a
    // single BackendEvent with both fields populated.
    let pendingFinishReason: string | null | undefined;
    let usagePromptTokens: number | undefined;
    let usageCompletionTokens: number | undefined;
    let usageContextWindow: number | undefined;

    // Drive the SSE iterator manually with `.next().catch(errMessage)` —
    // same pattern as the prompt handlers. Avoids
    // try/catch around the for-await loop and makes upstream errors
    // explicit as `{ ok: false, error }` results rather than thrown
    // exceptions wrapped in a translation handler.
    const iter = streamCompletion(
      serverConfig,
      {
        model: options.modelId,
        messages: options.messages as ChatMessage[],
        tools: options.tools as ToolDefinition[],
        stream: true,
        metadata: options.metadata,
        ...(options.effort ? { reasoning_effort: options.effort } : {}),
      },
      options.signal,
    )[Symbol.asyncIterator]();

    while (true) {
      const step = await iter.next().catch(errMessage);
      if (typeof step === "string") {
        yield { type: "error" as const, error: step };
        return;
      }
      if (step.done) break;

      const event: SSEEvent = step.value;
      switch (event.type) {
        case "content":
          yield { type: "text" as const, text: event.text };
          break;
        case "thinking":
          yield { type: "thinking" as const, text: event.text };
          break;
        case "tool_call_delta":
          mergeToolCallDelta(acc, event.delta);
          break;
        case "finish": {
          // Hold the finish until usage arrives. Tool calls are flushed
          // immediately so the agent loop can start dispatching while
          // the usage chunk is still in flight.
          pendingFinishReason = event.reason;
          const toolCalls = accumulateToolCallDeltas(acc);
          for (const tc of toolCalls) {
            const input = await parseToolCallArgs(
              tc.function.name,
              tc.function.arguments,
            );
            yield {
              type: "tool_call" as const,
              id: tc.id,
              name: tc.function.name,
              input,
              observeOnly: false,
            };
          }
          break;
        }
        case "usage":
          usagePromptTokens = event.promptTokens;
          usageCompletionTokens = event.completionTokens;
          usageContextWindow = event.contextWindow;
          break;
        case "error":
          yield { type: "error" as const, error: event.error };
          return;
      }
    }

    // Stream completed naturally — emit the buffered finish with usage
    // populated (if the server included it). When the upstream errored
    // we already returned above, so reaching here means a clean turn.
    yield {
      type: "finish" as const,
      stopReason: pendingFinishReason ?? undefined,
      ...(typeof usagePromptTokens === "number"
        ? { promptTokens: usagePromptTokens }
        : {}),
      ...(typeof usageCompletionTokens === "number"
        ? { completionTokens: usageCompletionTokens }
        : {}),
      ...(typeof usageContextWindow === "number"
        ? { contextWindow: usageContextWindow }
        : {}),
    };
  };

  return { kind: "server", run } satisfies Backend;
};
