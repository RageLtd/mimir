/**
 * Single-step turn streaming — the client-side successor to the server's
 * agent loop (MIM-89).
 *
 * The server loop ran MAX_AGENT_STEPS inner iterations because it executed
 * SERVER tools mid-stream. Locally there are none — the host (ACP's
 * prompt-server) executes every tool and re-invokes with updated history,
 * so one streamTurn call is exactly one model.doStream: stream deltas,
 * accumulate tool calls, emit a finish with usage. No SSE encoding, no
 * queue, no inner loop.
 *
 * Errors THROW (doStream failure, in-stream error part, stall timeout) —
 * callers drive the iterator with `.next().catch(...)`, the established
 * ACP pattern. Thrown messages pass through redactSecret when the caller
 * supplies the key, so provider errors can't echo credentials.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { log } from "../log";
import { parseToolInput } from "./json";

/** Stall guard for doStream returning (headers/handshake), not total turn
 *  duration — once the stream is live, reads have no deadline. */
const DO_STREAM_TIMEOUT_MS = 120_000;

export type TurnEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "finish";
      readonly reason: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

export type StreamTurnOptions = {
  readonly model: Pick<LanguageModelV3, "doStream">;
  readonly prompt: LanguageModelV3Prompt;
  readonly tools?: LanguageModelV3FunctionTool[];
  readonly providerOptions?: LanguageModelV3CallOptions["providerOptions"];
  readonly signal?: AbortSignal;
};

export async function* streamTurn(options: StreamTurnOptions) {
  const { model, prompt, tools, providerOptions, signal } = options;

  let streamTimeout: ReturnType<typeof setTimeout> | undefined;
  const doStreamResult = await Promise.race([
    model.doStream({
      prompt,
      tools,
      providerOptions,
      abortSignal: signal,
    }),
    new Promise<never>((_, reject) => {
      streamTimeout = setTimeout(
        () =>
          reject(
            new Error(`doStream timed out after ${DO_STREAM_TIMEOUT_MS}ms`),
          ),
        DO_STREAM_TIMEOUT_MS,
      );
    }),
    // Clear the timer on either outcome — otherwise every turn leaks a
    // live 120s timeout that keeps the process from idling.
  ]).finally(() => clearTimeout(streamTimeout));
  const { stream } = doStreamResult;

  // Accumulated tool calls flush AFTER the read loop: some providers emit
  // tool-call parts before trailing text/finish, and emitting per-part
  // keeps ordering identical to the server loop's behavior (calls
  // surfaced at step end).
  const toolCalls: TurnEvent[] = [];
  let finishReason = "stop";
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) break;

      switch (part.type) {
        case "text-delta":
          yield { type: "text", text: part.delta } satisfies TurnEvent;
          break;

        case "reasoning-delta":
          yield { type: "thinking", text: part.delta } satisfies TurnEvent;
          break;

        case "tool-call":
          // Normalize input to a parsed object ONCE at stream ingress —
          // every downstream consumer works with the object.
          toolCalls.push({
            type: "tool_call",
            id: String(part.toolCallId),
            name: String(part.toolName),
            input: parseToolInput(part.input) as Record<string, unknown>,
          });
          break;

        case "finish":
          finishReason = part.finishReason.unified;
          inputTokens = part.usage.inputTokens.total ?? 0;
          outputTokens = part.usage.outputTokens.total ?? 0;
          break;

        case "error":
          log.error("stream error", { err: String(part.error) });
          throw part.error instanceof Error
            ? part.error
            : new Error(String(part.error));

        default:
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield* toolCalls;

  yield {
    type: "finish",
    reason: finishReason,
    inputTokens,
    outputTokens,
  } satisfies TurnEvent;
}
