/**
 * Streaming response builder — drives the agent loop and produces
 * OpenAI-compatible SSE output.
 */

import type { MimirContext } from "../../middleware/types";
import { log } from "../../util/logger";
import { enqueueLlmCall } from "../queue";
import { agentLoop, type EmitSSE, type EmitUsage, type Model } from "./loop";
import { prepareTurn } from "./turn";

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export function streamingResponse(model: Model, ctx: MimirContext) {
  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = ctx.request.model;
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    start(controller) {
      // Emitters close over this response's controller — the loop never
      // sees it.
      const emitSSE: EmitSSE = (delta, finishReason = null) => {
        const chunk = {
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      };

      // Final-chunk usage emission per OpenAI spec when
      // stream_options.include_usage is true. Empty `choices` + top-level
      // `usage` is the wire format. The non-standard `context_window` is
      // mimir's extension so the ACP client can populate Zed's progress
      // bar without round-tripping to /v1/models.
      const emitUsage: EmitUsage = (usage) => {
        const chunk = {
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [],
          usage,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      };

      // Serialize through the LLM-call queue — one brain, one voice at a
      // time. Context assembly (persist trailing turn + read the log)
      // happens INSIDE the queued task, so a request arriving mid-turn
      // waits for the in-flight assistant reply to land before it
      // snapshots history. Persist→read→infer→persist is atomic per turn.
      enqueueLlmCall(async () => {
        const options = await prepareTurn(ctx);
        return agentLoop(model, options, ctx, emitSSE, emitUsage);
      })
        .catch((err) => {
          log.error({ err }, "agent loop error");
          const msg = err instanceof Error ? err.message : "Agent loop error";
          emitSSE({ content: `\n\n[Error: ${msg}]` });
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
