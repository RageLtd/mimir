/**
 * Agent loop — the core execution engine.
 *
 * LOOP:
 *   model.doStream(prompt, tools)
 *   → stream text/reasoning deltas to SSE
 *   → accumulate tool calls
 *   → if no tool calls: emit finish, break
 *   → classify: server vs client
 *   → if client calls: emit as SSE tool_calls, break
 *   → execute server tools (always produce a result)
 *   → append assistant message + tool results to prompt
 *   → continue
 */

import type {
  LanguageModelV3Message,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import {
  extractMemoriesFromResponse,
  persistAssistantTurn,
  triggerCompactionIfNeeded,
} from "../../agent-loop/post-processing";
import { getContextWindow } from "../../agent-loop/provider/query";
import { SERVER_TOOL_NAMES } from "../../agent-loop/server-tools";
import type { MimirContext } from "../../middleware/types";
import { log } from "../../util/logger";
import type { buildCallOptions } from "./tools";

export const MAX_AGENT_STEPS = 20;

export type Model = { doStream: Function; doGenerate: Function };
export type EmitSSE = (
  controller: ReadableStreamDefaultController,
  delta: Record<string, unknown>,
  finishReason?: string | null,
) => void;
export type EmitUsage = (
  controller: ReadableStreamDefaultController,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Non-standard mimir extension — model's max context window in tokens. */
    context_window?: number;
  },
) => void;

export async function agentLoop(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
  controller: ReadableStreamDefaultController,
  emitSSE: EmitSSE,
  emitUsage: EmitUsage,
) {
  const prompt: LanguageModelV3Message[] = [...(baseOptions.prompt ?? [])];
  let lastStepInputTokens = 0;
  // Sum across all agent steps so the final usage chunk reflects the
  // entire turn's output rather than just the last step's. Input tokens
  // already include accumulated context (the model's prompt grows each
  // step), so the LAST step's input is the right "prompt size at end of
  // turn" value.
  let totalOutputTokens = 0;
  let lastAssistantText = "";
  // Final assistant output destined for the client — accumulated here so
  // we can persist it to the global log once the turn ends. Server-tool
  // internal iterations are NOT persisted (they're ephemeral by design).
  let finalClientToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: string;
  }> = [];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    log.debug({ step, promptMessages: prompt.length }, "agent step");

    const { stream } = await model.doStream({
      ...baseOptions,
      prompt,
    });

    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: string;
    }> = [];
    let stepInputTokens = 0;
    let stepOutputTokens = 0;
    let finishReason = "stop";

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: part } = await reader.read();
        if (done) break;

        switch (part.type) {
          case "text-delta":
            textChunks.push(part.delta);
            emitSSE(controller, { content: part.delta });
            break;

          case "reasoning-delta":
            reasoningChunks.push(part.delta);
            emitSSE(controller, { reasoning_content: part.delta });
            break;

          case "tool-call":
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            break;

          case "finish":
            finishReason = part.finishReason.unified;
            stepInputTokens = part.usage.inputTokens.total ?? 0;
            stepOutputTokens = part.usage.outputTokens.total ?? 0;
            break;

          case "error":
            log.error({ err: part.error }, "stream error");
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

    lastStepInputTokens = stepInputTokens;
    totalOutputTokens += stepOutputTokens;
    lastAssistantText = textChunks.join("");

    log.debug(
      {
        step,
        finishReason,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        toolCalls: toolCalls.length,
        textLength: lastAssistantText.length,
      },
      "step finished",
    );

    // No tool calls → done
    if (toolCalls.length === 0) {
      emitSSE(controller, {}, finishReason === "stop" ? "stop" : finishReason);
      break;
    }

    // Classify: server vs client
    const serverCalls = toolCalls.filter((tc) =>
      SERVER_TOOL_NAMES.has(tc.toolName),
    );
    const clientCalls = toolCalls.filter(
      (tc) => !SERVER_TOOL_NAMES.has(tc.toolName),
    );

    // Client tool calls → emit and stop
    if (clientCalls.length > 0) {
      finalClientToolCalls = clientCalls;
      let i = 0;
      for (const tc of clientCalls) {
        emitSSE(
          controller,
          {
            tool_calls: [
              {
                index: i,
                id: tc.toolCallId,
                type: "function",
                function: {
                  name: tc.toolName,
                  arguments: tc.input,
                },
              },
            ],
          },
          i === clientCalls.length - 1 ? "tool_calls" : null,
        );
        i++;
      }
      break;
    }

    // Server tool calls → execute and loop
    appendServerStepToPrompt(
      prompt,
      lastAssistantText,
      reasoningChunks,
      serverCalls,
    );
    await executeServerTools(prompt, serverCalls, ctx);
  }

  // Emit the OpenAI-spec usage chunk (empty choices + top-level usage)
  // before [DONE]. Includes a non-standard `context_window` so the ACP
  // client can populate Zed's progress bar without a separate /v1/models
  // call. `lastStepInputTokens` is the right "prompt size at end of turn"
  // value because each agent step appends to the prompt — the final
  // step's input includes all accumulated context.
  emitUsage(controller, {
    prompt_tokens: lastStepInputTokens,
    completion_tokens: totalOutputTokens,
    total_tokens: lastStepInputTokens + totalOutputTokens,
    ...(typeof ctx.request.model === "string"
      ? { context_window: getContextWindow(ctx.request.model) }
      : {}),
  });

  // Persist the final assistant turn — server owns its own writes.
  // Fire-and-forget; logs on failure but never blocks the response.
  persistAssistantTurn(
    lastAssistantText,
    finalClientToolCalls,
    ctx.project,
  ).catch((err) =>
    log.error({ err }, "persistAssistantTurn failed (streaming)"),
  );

  // Post-processing (fire-and-forget)
  triggerCompactionIfNeeded(
    lastStepInputTokens,
    ctx.project,
    ctx.request.model,
  );

  const lastUserMessage = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");
  extractMemoriesFromResponse(
    lastAssistantText || null,
    lastUserMessage ?? null,
    ctx.project,
  );
}

// ---------------------------------------------------------------------------
// Server tool step handling
// ---------------------------------------------------------------------------

/**
 * Append assistant message with text + reasoning + tool calls to the prompt.
 */
export function appendServerStepToPrompt(
  prompt: LanguageModelV3Message[],
  text: string,
  reasoning: string[],
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  const parts: Array<
    | LanguageModelV3TextPart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
  > = [];
  if (text) parts.push({ type: "text", text });
  if (reasoning.length > 0) {
    parts.push({ type: "reasoning", text: reasoning.join("") });
  }
  for (const tc of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: safeParseJSON(tc.input),
    });
  }
  prompt.push({ role: "assistant", content: parts });
}

/**
 * Execute server tools sequentially, always producing a result.
 * Appends tool result message to prompt.
 */
export async function executeServerTools(
  prompt: LanguageModelV3Message[],
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
  ctx: MimirContext,
) {
  const toolResults: LanguageModelV3ToolResultPart[] = [];

  for (const tc of toolCalls) {
    const tool = ctx.serverTools[tc.toolName];
    const parsedInput = safeParseJSON(tc.input);
    let resultValue: string;

    if (!tool?.execute) {
      resultValue = `Error: tool ${tc.toolName} has no execute function`;
    } else {
      try {
        const result = await tool.execute(parsedInput, {
          toolCallId: tc.toolCallId,
          messages: [],
          abortSignal: undefined,
        });
        resultValue =
          typeof result === "string" ? result : JSON.stringify(result ?? "");
      } catch (err) {
        log.error(
          { err, toolName: tc.toolName },
          "server tool execution failed",
        );
        resultValue = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    toolResults.push({
      type: "tool-result" as const,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      output: { type: "text" as const, value: resultValue },
    });
  }

  prompt.push({ role: "tool", content: toolResults });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJSON(str: string) {
  try {
    return JSON.parse(str);
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "safeParseJSON failed, returning raw string",
    );
    return str;
  }
}
