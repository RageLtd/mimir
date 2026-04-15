/**
 * Agent runner — entry point.
 *
 * Manual doStream/doGenerate loop replacing the AI SDK's multi-step
 * agent pipeline. Keeps the provider abstraction without the pipeline's
 * validation bugs (MissingToolResultsError, parallel write ordering).
 */

import type { MimirContext } from "../../middleware/types";
import { buildPrompt } from "./prompt";
import { nonStreamingResponse, streamingResponse } from "./response";
import { buildCallOptions, buildTools } from "./tools";

export { resolveModel } from "../provider-registry";

/**
 * Run the agent with the prepared context.
 * Returns an OpenAI-compatible Response (streaming or non-streaming).
 */
export function runAgent(ctx: MimirContext) {
  const model = resolveModel(ctx.request.model);
  ctx.resolvedModel = model;

  const prompt = buildPrompt(ctx);
  const tools = buildTools(ctx);
  const options = buildCallOptions(ctx, prompt, tools);

  if (ctx.request.stream) {
    return streamingResponse(model, options, ctx);
  }
  return nonStreamingResponse(model, options, ctx);
}

// Re-import for local use
import { resolveModel } from "../provider-registry";
