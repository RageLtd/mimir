/**
 * Anthropic Messages API ingress — POST /v1/messages.
 *
 * Accepts Anthropic-shaped requests (the wire format Claude Code emits
 * when `ANTHROPIC_BASE_URL` is pointed at mimir-server), translates
 * them through the existing middleware pipeline + agent loop, and
 * streams Anthropic SSE events back. The translation layer lives in
 * `anthropic-format.ts` (request) and `anthropic-stream.ts`
 * (response); this file is the routing + middleware orchestration.
 *
 * Phase 1 scope: streaming, text-only. Tool definitions and tool_use
 * round-tripping land in Phase 2 — for now, `tools` on the request is
 * logged and ignored so the handler still answers the text portion.
 */

import { Hono } from "hono";
import { z } from "zod";
import { runAgent } from "../agent/run";
import {
  createMimirContext,
  generateRequestId,
  prepareContext,
} from "../middleware/pipeline";
import type { ChatRequest } from "../middleware/types";
import { requestLog } from "../util/logger";
import {
  type AnthropicRequest,
  normalizeAnthropicRequest,
} from "./anthropic-format";
import { anthropicStreamingResponse } from "./anthropic-stream";

// ---------------------------------------------------------------------------
// Zod Schema — validates inbound Anthropic Messages API requests
// ---------------------------------------------------------------------------

const anthropicSystemBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const anthropicContentBlockSchema = z.looseObject({
  type: z.string(),
});

const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentBlockSchema)]),
});

const anthropicRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(anthropicMessageSchema),
  system: z.union([z.string(), z.array(anthropicSystemBlockSchema)]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const messagesIngress = new Hono();

messagesIngress.post("/", async (c) => {
  const requestId = generateRequestId();
  const log = requestLog(requestId);

  const rawBody = await c.req.json();
  const parsed = anthropicRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues },
      "anthropic ingress validation failed",
    );
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid Anthropic Messages API request",
        },
      },
      400,
    );
  }

  const normalized = normalizeAnthropicRequest(parsed.data as AnthropicRequest);

  // Phase 1 always streams. Refuse non-streaming requests so we don't
  // silently ship a half-implementation; non-streaming support arrives
  // later if a real consumer needs it.
  if (!normalized.stream) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Non-streaming Anthropic Messages API requests are not yet supported. Set stream: true.",
        },
      },
      400,
    );
  }

  const chatRequest: ChatRequest = {
    model: normalized.model,
    messages: normalized.messages,
    stream: true,
    tools: normalized.tools,
    temperature: normalized.temperature,
    top_p: normalized.top_p,
    max_tokens: normalized.max_tokens,
    metadata: (parsed.data.metadata ?? undefined) as ChatRequest["metadata"],
  };

  try {
    const ctx = createMimirContext(chatRequest);

    // System prompt resolution: prefer the client's `system` field (CC
    // launched via wrapper carries the Mimir prompt verbatim through
    // --system-prompt-file). A pre-set systemPrompt short-circuits the
    // pipeline's system-prompt stage; the server's on-disk prompt is the
    // fallback so the assistant is never promptless.
    if (normalized.systemPrompt) {
      ctx.systemPrompt = normalized.systemPrompt;
    }

    await prepareContext(ctx);

    log.info(
      {
        model: ctx.request.model,
        messageCount: chatRequest.messages.length,
        hasSystem: Boolean(normalized.systemPrompt),
        clientToolCount: normalized.tools?.length ?? 0,
      },
      "anthropic ingress dispatched",
    );

    return runAgent(ctx, anthropicStreamingResponse);
  } catch (err) {
    log.error({ err }, "anthropic ingress pipeline failed");
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: err instanceof Error ? err.message : "Pipeline error",
        },
      },
      500,
    );
  }
});
