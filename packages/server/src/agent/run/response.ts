/**
 * Response builders — streaming (SSE) and non-streaming (JSON).
 *
 * Both modes drive the agent loop and produce OpenAI-compatible output.
 */

import type { LanguageModelV3Message } from "@ai-sdk/provider";
import {
  extractMemoriesFromResponse,
  triggerCompactionIfNeeded,
} from "../../agent-loop/post-processing";
import { SERVER_TOOL_NAMES } from "../../agent-loop/server-tools";
import type { MimirContext } from "../../middleware/types";
import { log } from "../../util/logger";
import {
  agentLoop,
  appendServerStepToPrompt,
  type EmitSSE,
  executeServerTools,
  MAX_AGENT_STEPS,
  type Model,
} from "./loop";
import type { buildCallOptions } from "./tools";

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export function streamingResponse(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
) {
  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = ctx.request.model;
  const encoder = new TextEncoder();

  const emitSSE: EmitSSE = (controller, delta, finishReason = null) => {
    const chunk = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const readable = new ReadableStream({
    start(controller) {
      agentLoop(model, baseOptions, ctx, controller, emitSSE)
        .catch((err) => {
          log.error({ err }, "agent loop error");
          const msg = err instanceof Error ? err.message : "Agent loop error";
          emitSSE(controller, { content: `\n\n[Error: ${msg}]` });
        })
        .finally(() => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        });
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------

export async function nonStreamingResponse(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
) {
  const prompt: LanguageModelV3Message[] = [...(baseOptions.prompt ?? [])];
  let lastStepInputTokens = 0;
  let lastText = "";
  let lastToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: string;
  }> = [];
  let lastFinishReason = "stop";

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const result = await model.doGenerate({
      ...baseOptions,
      prompt,
    });

    lastStepInputTokens = result.usage.inputTokens.total ?? 0;
    lastFinishReason = result.finishReason.unified;

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: typeof lastToolCalls = [];

    for (const part of result.content) {
      switch (part.type) {
        case "text":
          textParts.push(part.text);
          break;
        case "reasoning":
          reasoningParts.push(part.text);
          break;
        case "tool-call":
          toolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
      }
    }

    lastText = textParts.join("");
    lastToolCalls = toolCalls;

    log.debug(
      {
        step,
        finishReason: lastFinishReason,
        inputTokens: lastStepInputTokens,
        outputTokens: result.usage.outputTokens.total ?? 0,
        toolCalls: toolCalls.length,
        textLength: lastText.length,
      },
      "non-streaming step finished",
    );

    if (toolCalls.length === 0) break;

    const clientCalls = toolCalls.filter(
      (tc) => !SERVER_TOOL_NAMES.has(tc.toolName),
    );
    if (clientCalls.length > 0) {
      lastToolCalls = clientCalls;
      lastFinishReason = "tool-calls";
      break;
    }

    const serverCalls = toolCalls.filter((tc) =>
      SERVER_TOOL_NAMES.has(tc.toolName),
    );

    appendServerStepToPrompt(prompt, lastText, reasoningParts, serverCalls);
    await executeServerTools(prompt, serverCalls, ctx);
    lastToolCalls = [];
  }

  // Post-processing
  triggerCompactionIfNeeded(
    lastStepInputTokens,
    ctx.project,
    ctx.request.model,
  );

  const lastUserMessage = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");
  extractMemoriesFromResponse(
    lastText || null,
    lastUserMessage ?? null,
    ctx.project,
  );

  // Build OpenAI-compatible response
  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const finishReason =
    lastFinishReason === "stop"
      ? "stop"
      : lastFinishReason === "tool-calls"
        ? "tool_calls"
        : lastFinishReason;

  return new Response(
    JSON.stringify({
      id: streamId,
      object: "chat.completion",
      created,
      model: ctx.request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: lastText || null,
            tool_calls:
              lastToolCalls.length > 0
                ? lastToolCalls.map((tc) => ({
                    id: tc.toolCallId,
                    type: "function" as const,
                    function: {
                      name: tc.toolName,
                      arguments: tc.input,
                    },
                  }))
                : undefined,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: lastStepInputTokens,
        completion_tokens: 0,
        total_tokens: lastStepInputTokens,
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}
