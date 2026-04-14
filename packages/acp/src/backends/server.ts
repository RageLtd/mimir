/**
 * Server backend adapter.
 *
 * Thin wrapper over the existing streamCompletion + sse-parser pipeline.
 * Translates SSEEvent → BackendEvent so the agent loop can be backend-agnostic.
 *
 * The server backend's tool calls are real requests to be executed by the
 * agent loop, so observeOnly is always false here.
 */

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
} from "../sse-parser";
import { errMessage } from "../util";
import type { Backend, BackendEvent, BackendRunOptions } from "./types";

export const createServerBackend = (
  serverConfig: ServerClientConfig,
): Backend => {
  const run = async function* (
    options: BackendRunOptions,
  ): AsyncGenerator<BackendEvent> {
    const acc = new Map<number, MutableToolCall>();

    try {
      for await (const event of streamCompletion(
        serverConfig,
        {
          model: options.modelId,
          messages: options.messages as ChatMessage[],
          tools: options.tools as ToolDefinition[],
          stream: true,
          metadata: options.metadata,
        },
        options.signal,
      )) {
        switch (event.type) {
          case "content":
            yield { type: "text", text: event.text };
            break;
          case "tool_call_delta":
            mergeToolCallDelta(acc, event.delta);
            break;
          case "finish": {
            const toolCalls = accumulateToolCallDeltas(acc);
            for (const tc of toolCalls) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(tc.function.arguments);
              } catch {
                input = {};
              }
              yield {
                type: "tool_call",
                id: tc.id,
                name: tc.function.name,
                input,
                observeOnly: false,
              };
            }
            yield { type: "finish", stopReason: event.reason ?? undefined };
            return;
          }
          case "error":
            yield { type: "error", error: event.error };
            return;
        }
      }
    } catch (err) {
      yield { type: "error", error: errMessage(err) };
    }
  };

  return { kind: "server", run };
};
