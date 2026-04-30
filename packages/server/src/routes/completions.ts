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
import { runAgent } from "../agent/run";
import { getSmallModelConfig } from "../agent-loop/provider/query";
import { assembleContext } from "../middleware/context-assembly";
import { injectMemories } from "../middleware/goldfish";
import { injectSystemPrompt } from "../middleware/system-prompt";
import { classifyTools } from "../middleware/tool-classification";
import type {
  ChatRequest,
  MimirContext,
  OpenAIToolDef,
} from "../middleware/types";
import { injectUserProfile } from "../middleware/user-profile";
import { requestLog } from "../util/logger";
import { normalizeMessages } from "./openai-format";

// Message format translation (OpenAI ↔ AI SDK ModelMessage) lives in
// ./openai-format.ts so this file reads as routing logic.

/**
 * Generate a correlation ID for request logging.
 */
function generateRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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
  const project = (req.metadata?.project as string) ?? "default";

  // --- Utility request short-circuit ---
  // No tools = utility request (title gen, summarization, etc.)
  // Proxy directly to the small model, skip the entire middleware pipeline.
  const hasTools = (req.tools ?? []).length > 0;
  if (!hasTools) {
    log.debug("utility request detected (no tools) — proxying to small model");
    return proxyToSmallModel(req, c);
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

  // Build initial context — the typed object for the pipeline
  const ctx: MimirContext = {
    request: req,
    project,
    sessionId: fingerprint(req),
    // Filled by middleware:
    systemPrompt: "",
    memories: null,
    conversationMessages: [],
    contextInjection: [],
    compactionTriggered: false,
    serverTools: {},
    clientTools: {},
    allTools: {},
    resolvedModel: null,
  };

  try {
    // Run middleware pipeline — each mutates ctx
    await injectSystemPrompt(ctx);
    await injectMemories(ctx);
    injectUserProfile(ctx);
    await assembleContext(ctx);
    await classifyTools(ctx);

    // Run agent and return response
    return runAgent(ctx);
  } catch (err) {
    log.error({ err }, "middleware pipeline failed");
    return c.json(
      {
        error: {
          message: err instanceof Error ? err.message : "Pipeline error",
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
 * Deterministic session ID from first user message content.
 * Falls back to request hash if no user message found.
 */
function fingerprint(req: ChatRequest) {
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
            .map((p) => p.text)
            .join(" ")
        : "";

  return Bun.hash(content).toString(36);
}

/**
 * Proxy a utility request (no tools) directly to the small model.
 * Skips the entire middleware pipeline — no system prompt, no memories,
 * no persistence. Just a clean pass-through.
 */
async function proxyToSmallModel(
  req: ChatRequest,
  c: Context,
): Promise<Response> {
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
