/**
 * Middleware pipeline — the ONE place the MimirContext is created and the
 * middleware chain is ordered.
 *
 * Both ingress routes (`/v1/chat/completions`, `/v1/messages`) translate
 * their wire format into a ChatRequest, then call `createMimirContext` +
 * `prepareContext`. Neither route owns pipeline knowledge: adding a
 * context field or a middleware stage touches this file only.
 */

import { injectMemories } from "./goldfish";
import { injectProjectRules } from "./project-rules";
import { injectSystemPrompt } from "./system-prompt";
import { classifyTools } from "./tool-classification";
import type { ChatRequest, MimirContext } from "./types";
import { injectUserProfile } from "./user-profile";

/** Correlation ID for request logging. */
export function generateRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build the initial context object for the pipeline.
 * Every field the middleware chain fills starts empty here.
 */
export function createMimirContext(request: ChatRequest) {
  return {
    request,
    project: (request.metadata?.project as string | undefined) ?? "default",
    systemPrompt: "",
    memories: null,
    playbooks: null,
    projectRules: null,
    conversationMessages: [],
    contextInjection: [],
    compactionTriggered: false,
    serverTools: {},
    clientTools: {},
    allTools: {},
    resolvedModel: null,
  };
}

/**
 * Run the middleware chain over a fresh context.
 *
 * A pre-set `ctx.systemPrompt` (the Anthropic ingress carries the client's
 * `system` field verbatim) short-circuits the system-prompt stage — the
 * fallback to the server's on-disk prompt only applies when the client
 * supplied nothing.
 *
 * Deliberately EXCLUDES context assembly. Assembly persists the client's
 * trailing turn and reads the log back — it must run inside the LLM-call
 * queue (see agent/run/turn.ts) so that persist→read→infer→persist is
 * atomic per turn. Running it here would let a request that arrives
 * mid-turn snapshot the log before the in-flight assistant reply lands.
 */
export async function prepareContext(ctx: MimirContext) {
  if (!ctx.systemPrompt) await injectSystemPrompt(ctx);
  await injectMemories(ctx);
  injectUserProfile(ctx);
  injectProjectRules(ctx);
  await classifyTools(ctx);
  return ctx;
}
