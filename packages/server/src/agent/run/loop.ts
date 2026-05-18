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
  LanguageModelV3,
  LanguageModelV3Message,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import {
  classifyToolCalls,
  finalizeTurn,
} from "../../agent-loop/post-processing";
import { getContextWindow } from "../../agent-loop/provider/query";
import type { MimirContext } from "../../middleware/types";
import { safeParseJSON } from "../../util/json";
import { log } from "../../util/logger";
import type { buildCallOptions } from "./tools";

export const MAX_AGENT_STEPS = 20;

export type Model = Pick<LanguageModelV3, "doStream" | "doGenerate">;
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
  let lastReasoningText = "";
  // Final assistant output destined for the client — accumulated here so
  // we can persist it to the global log once the turn ends. Server-tool
  // internal iterations are NOT persisted (they're ephemeral by design).
  // Record<string, unknown> to carry providerMetadata and any future
  // SDK fields through the loop without enumerating.
  let finalClientToolCalls: Array<Record<string, unknown>> = [];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    log.info(
      { step, promptMessages: prompt.length, model: ctx.request.model },
      "agent step — calling doStream",
    );

    const doStreamResult = await Promise.race([
      model.doStream({ ...baseOptions, prompt }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("doStream timed out after 120s")),
          120_000,
        ),
      ),
    ]);
    const { stream } = doStreamResult;

    log.info({ step }, "doStream returned — reading chunks");

    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    // Spread source parts — carry all fields (providerMetadata, etc.)
    // rather than enumerating. Only override `input` with the normalized
    // version. This ensures Google's thoughtSignature and any future
    // SDK fields survive the round-trip through the agent loop.
    const toolCalls: Array<Record<string, unknown>> = [];
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

          case "tool-call": {
            const input =
              typeof part.input === "string"
                ? safeParseJSON(part.input)
                : (part.input ?? {});
            toolCalls.push({
              ...part,
              input: JSON.stringify(input),
            });
            break;
          }

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
    lastReasoningText = reasoningChunks.join("");

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
    const { serverCalls, clientCalls } = classifyToolCalls(toolCalls);

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
                id: String(tc.toolCallId),
                type: "function",
                function: {
                  name: String(tc.toolName),
                  arguments: String(tc.input),
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

  // Post-processing: persist, compact, extract memories (fire-and-forget)
  finalizeTurn(
    lastAssistantText,
    finalClientToolCalls,
    lastReasoningText || undefined,
    ctx,
    lastStepInputTokens,
  );
}

// ---------------------------------------------------------------------------
// Server tool step handling
// ---------------------------------------------------------------------------

/**
 * Append assistant message with text + reasoning + tool calls to the prompt.
 * Spreads tool call fields to preserve providerMetadata (Google thoughtSignature)
 * and any future SDK fields — only override `input` with the parsed version.
 */
export function appendServerStepToPrompt(
  prompt: LanguageModelV3Message[],
  text: string,
  reasoning: string[],
  toolCalls: Array<Record<string, unknown>>,
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
      ...tc,
      type: "tool-call",
      toolCallId: String(tc.toolCallId),
      toolName: String(tc.toolName),
      input: safeParseJSON(
        typeof tc.input === "string"
          ? tc.input
          : JSON.stringify(tc.input ?? {}),
      ),
      // doStream emits thoughtSignature via providerMetadata, but providers
      // (Google) read from providerOptions when formatting outgoing messages.
      // Map explicitly so the signature survives the round-trip.
      providerOptions: providerOptionsFromToolCall(tc),
    });
  }
  prompt.push({ role: "assistant", content: parts });
}

function providerOptionsFromToolCall(toolCall: Record<string, unknown>) {
  const options = toolCall.providerMetadata ?? toolCall.providerOptions;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(options));
}

/**
 * Execute server tools sequentially, always producing a result.
 * Appends tool result message to prompt.
 */
export async function executeServerTools(
  prompt: LanguageModelV3Message[],
  toolCalls: Array<Record<string, unknown>>,
  ctx: MimirContext,
) {
  const toolResults: LanguageModelV3ToolResultPart[] = [];

  for (const tc of toolCalls) {
    const toolName = String(tc.toolName);
    const toolCallId = String(tc.toolCallId);
    const tool = ctx.serverTools[toolName];
    const parsedInput = safeParseJSON(
      typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
    );
    let resultValue: string;

    if (!tool?.execute) {
      resultValue = `Error: tool ${toolName} has no execute function`;
    } else {
      try {
        const result = await tool.execute(parsedInput, {
          toolCallId,
          messages: [],
          abortSignal: undefined,
        });
        resultValue =
          typeof result === "string" ? result : JSON.stringify(result ?? "");
      } catch (err) {
        log.error({ err, toolName }, "server tool execution failed");
        resultValue = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    toolResults.push({
      type: "tool-result" as const,
      toolCallId,
      toolName,
      output: { type: "text" as const, value: resultValue },
    });
  }

  prompt.push({ role: "tool", content: toolResults });
}
