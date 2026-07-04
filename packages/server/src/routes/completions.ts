/**
 * Routes: POST /v1/chat/completions
 *
 * Thin route handler — validates input, builds context, runs middleware pipeline,
 * and hands off to the agent runner.
 *
 * This is the ONE place we parse the incoming JSON. After validation, data flows
 * as typed objects through the middleware pipeline. No more ad-hoc JSON transforms.
 */

import { type Context, Hono } from "hono";
import { z } from "zod";
import { getSmallModelConfig } from "../agent/provider/query";
import { runAgent } from "../agent/run";
import {
  createMimirContext,
  extractProviderOverride,
  generateRequestId,
  PROVIDER_KEY_HEADER,
  prepareContext,
} from "../middleware/pipeline";
import type { ChatRequest, OpenAIToolDef } from "../middleware/types";
import { requestLog } from "../util/logger";
import { redactSecret } from "../util/redact";
import { normalizeMessages } from "./openai-format";

// Message format translation (OpenAI ↔ AI SDK ModelMessage) lives in
// ./openai-format.ts so this file reads as routing logic. Context
// creation and the middleware chain live in ../middleware/pipeline.ts.

// ---------------------------------------------------------------------------
// Zod Schema — the ONE place we validate/parse
// ---------------------------------------------------------------------------

const chatRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      // nullish: Zed sends content: null on assistant messages with only tool_calls
      content: z.union([z.string(), z.array(z.unknown())]).nullish(),
      tool_calls: z
        .array(
          z.object({
            id: z.string(),
            type: z.literal("function"),
            function: z.object({
              name: z.string(),
              arguments: z.string().optional().default("{}"),
            }),
          }),
        )
        .optional(),
      tool_call_id: z.string().optional(),
      reasoning_content: z.string().nullish(),
    }),
  ),
  stream: z.boolean().optional().default(true),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reasoning_effort: z.string().nullish(),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
});

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export const completions = new Hono();

completions.post("/v1/chat/completions", async (c) => {
  // Correlation ID for request logging
  const requestId = generateRequestId();
  const log = requestLog(requestId);

  // Parse and validate
  const body = await c.req.json();
  const parsed = chatRequestSchema.safeParse(body);

  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues, lastMessages: body.messages?.slice(-3) },
      "request validation failed",
    );
    return c.json(
      { error: { message: "Invalid request", details: parsed.error.issues } },
      400,
    );
  }

  let req = parsed.data as ChatRequest;

  // --- Utility request short-circuit ---
  // No tools = utility request (title gen, summarization, etc.)
  // Proxy directly to the small model, skip the entire middleware pipeline.
  const hasTools = (req.tools ?? []).length > 0;
  if (!hasTools) {
    log.debug("utility request detected (no tools) — proxying to small model");
    return proxyToSmallModel(req, c);
  }

  // The agent path streams exclusively — the non-streaming JSON builder was
  // removed because the loop relies on SSE for tool-observation visibility and
  // the ACP client never requests non-streaming. Utility requests (short-
  // circuited above) may still be non-streaming. Reject a non-streaming agent
  // request rather than silently returning a stream the caller didn't ask for.
  if (!req.stream) {
    return c.json(
      {
        error: {
          message:
            "Non-streaming agent requests are not supported. Set stream: true.",
        },
      },
      400,
    );
  }

  // Normalize messages to AI SDK format before passing to middleware
  const normalized = normalizeMessages(req.messages);
  log.info(
    {
      beforeRoles: req.messages.map(
        (m) =>
          `${m.role}:${typeof m.content === "string" ? "string" : "array"}`,
      ),
      afterRoles: normalized.map(
        (m) =>
          `${m.role}:${typeof m.content === "string" ? "string" : "array"}`,
      ),
    },
    "message normalization",
  );
  req = { ...req, messages: normalized };

  logRequest(requestLog(requestId), req);

  // BYOK (MIM-73): per-request provider key from the transport header.
  const providerOverride = extractProviderOverride(
    c.req.header(PROVIDER_KEY_HEADER),
    req.metadata,
  );

  try {
    const ctx = await prepareContext(
      createMimirContext(req, { providerOverride }),
    );
    return runAgent(ctx);
  } catch (err) {
    log.error({ err }, "middleware pipeline failed");
    return c.json(
      {
        error: {
          // BYOK key scrub — provider errors can echo request headers.
          message: redactSecret(
            err instanceof Error ? err.message : "Pipeline error",
            providerOverride?.apiKey,
          ),
        },
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Log a structured summary of the incoming request */
function logRequest(log: ReturnType<typeof requestLog>, req: ChatRequest) {
  const toolNames = (req.tools ?? [])
    .map((t: OpenAIToolDef) => t.function.name)
    .filter(Boolean);

  log.debug({ stream: req.stream, model: req.model ?? "default" }, "request");

  if (toolNames.length > 0) {
    log.debug({ toolNames }, "client tools");
  }
}

/**
 * Proxy a utility request (no tools) directly to the small model.
 * Skips the entire middleware pipeline — no system prompt, no memories,
 * no persistence. Just a clean pass-through.
 */
async function proxyToSmallModel(req: ChatRequest, c: Context) {
  const smallModel = getSmallModelConfig();
  if (!smallModel) {
    return c.json(
      { error: { message: "No small model configured for utility requests" } },
      500,
    );
  }

  const { baseUrl, apiKey, model } = smallModel;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    model,
    messages: req.messages,
    stream: req.stream ?? true,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
  });

  const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });

  // Pipe the response straight through
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "application/json",
      "Transfer-Encoding":
        upstream.headers.get("Transfer-Encoding") ?? undefined,
    },
  });
}
