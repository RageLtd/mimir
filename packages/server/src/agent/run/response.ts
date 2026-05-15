/**
 * Response builders — streaming (SSE) and non-streaming (JSON).
 *
 * Both modes drive the agent loop and produce OpenAI-compatible output.
 */

import type { LanguageModelV3Message } from "@ai-sdk/provider";
import {
  classifyToolCalls,
  finalizeTurn,
} from "../../agent-loop/post-processing";
import type { MimirContext } from "../../middleware/types";
import { log } from "../../util/logger";
import { enqueueLlmCall } from "../queue";
import {
  agentLoop,
  appendServerStepToPrompt,
  type EmitSSE,
  type EmitUsage,
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

  // Final-chunk usage emission per OpenAI spec when stream_options.include_usage
  // is true. Empty `choices` + top-level `usage` is the wire format. The
  // non-standard `context_window` is mimir's extension so the ACP client can
  // populate Zed's progress bar without round-tripping to /v1/models.
  const emitUsage: EmitUsage = (controller, usage) => {
    const chunk = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [],
      usage,
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const readable = new ReadableStream({
    start(controller) {
      // Serialize through the LLM-call queue — one brain, one voice at a
      // time. Concurrent requests wait their turn, keeping the log
      // coherent (an assistant reply never lands next to a user message
      // it wasn't responding to).
      enqueueLlmCall(() =>
        agentLoop(model, baseOptions, ctx, controller, emitSSE, emitUsage),
      )
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
  // Serialize non-streaming calls through the same queue as streaming —
  // one brain, one in-flight inference at a time.
  return enqueueLlmCall(() =>
    nonStreamingResponseImpl(model, baseOptions, ctx),
  );
}

async function nonStreamingResponseImpl(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
) {
  const prompt: LanguageModelV3Message[] = [...(baseOptions.prompt ?? [])];
  let lastStepInputTokens = 0;
  let lastText = "";
  let lastReasoning = "";
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
            input: JSON.stringify(part.input ?? {}),
          });
          break;
      }
    }

    lastText = textParts.join("");
    lastReasoning = reasoningParts.join("");
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

    const { serverCalls, clientCalls } = classifyToolCalls(toolCalls);
    if (clientCalls.length > 0) {
      lastToolCalls = clientCalls;
      lastFinishReason = "tool-calls";
      break;
    }

    appendServerStepToPrompt(prompt, lastText, reasoningParts, serverCalls);
    await executeServerTools(prompt, serverCalls, ctx);
    lastToolCalls = [];
  }

  // Post-processing: persist, compact, extract memories (fire-and-forget)
  finalizeTurn(
    lastText,
    lastToolCalls,
    lastReasoning || undefined,
    ctx,
    lastStepInputTokens,
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
