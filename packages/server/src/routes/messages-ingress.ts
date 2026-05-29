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
import { resolveModel } from "../agent/provider-registry";
import { buildPrompt } from "../agent/run/prompt";
import { buildCallOptions, buildTools } from "../agent/run/tools";
import { assembleContext } from "../middleware/context-assembly";
import { injectMemories } from "../middleware/goldfish";
import { injectProjectRules } from "../middleware/project-rules";
import { injectSystemPrompt } from "../middleware/system-prompt";
import { classifyTools } from "../middleware/tool-classification";
import type { ChatRequest, MimirContext } from "../middleware/types";
import { injectUserProfile } from "../middleware/user-profile";
import { requestLog } from "../util/logger";
import {
  type AnthropicRequest,
  normalizeAnthropicRequest,
} from "./anthropic-format";
import { anthropicStreamingResponse } from "./anthropic-stream";

const generateRequestId = () =>
  `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const fingerprint = (req: ChatRequest) => {
  const first = req.messages.find((m) => m.role === "user");
  if (!first) {
    return Bun.hash(JSON.stringify(req)).toString(36);
  }
  const content =
    typeof first.content === "string"
      ? first.content
      : Array.isArray(first.content)
        ? first.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text?: string }).text ?? "")
            .join(" ")
        : "";
  return Bun.hash(content).toString(36);
};

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

  const project =
    (chatRequest.metadata?.project as string | undefined) ?? "default";

  const ctx: MimirContext = {
    request: chatRequest,
    project,
    sessionId: fingerprint(chatRequest),
    systemPrompt: "",
    memories: null,
    projectRules: null,
    conversationMessages: [],
    contextInjection: [],
    compactionTriggered: false,
    serverTools: {},
    clientTools: {},
    allTools: {},
    resolvedModel: null,
  };

  // System prompt resolution: prefer the client's `system` field (CC
  // launched via wrapper carries the Mimir prompt verbatim through
  // --system-prompt-file). Fall back to the server's on-disk prompt
  // when the client supplies nothing so the assistant is never
  // promptless.
  if (normalized.systemPrompt) {
    ctx.systemPrompt = normalized.systemPrompt;
  } else {
    await injectSystemPrompt(ctx);
  }

  await injectMemories(ctx);
  injectUserProfile(ctx);
  injectProjectRules(ctx);
  await assembleContext(ctx);
  await classifyTools(ctx);

  const model = resolveModel(ctx.request.model);
  ctx.resolvedModel = model;

  const prompt = buildPrompt(ctx);
  const tools = buildTools(ctx);
  const options = buildCallOptions(ctx, prompt, tools);

  log.info(
    {
      model: ctx.request.model,
      messageCount: chatRequest.messages.length,
      hasSystem: Boolean(normalized.systemPrompt),
      clientToolCount: normalized.tools?.length ?? 0,
    },
    "anthropic ingress dispatched",
  );

  return anthropicStreamingResponse(model, options, ctx);
});
