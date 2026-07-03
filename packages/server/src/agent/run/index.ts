/**
 * Agent runner — entry point.
 *
 * Manual doStream/doGenerate loop replacing the AI SDK's multi-step
 * agent pipeline. Keeps the provider abstraction without the pipeline's
 * validation bugs (MissingToolResultsError, parallel write ordering).
 *
 * Always streams. Non-streaming requests are rejected at the route level
 * because the agent loop relies on SSE for tool-observation visibility and
 * the ACP client expects streaming exclusively.
 */

import type { MimirContext } from "../../middleware/types";
import { resolveModel } from "../provider";
import { streamingResponse } from "./response";

/**
 * Run the agent with the prepared context.
 *
 * `respond` selects the wire format for the SSE stream — OpenAI chunks by
 * default, or `anthropicStreamingResponse` for the /v1/messages ingress.
 * Both encoders share the (model, ctx) → Response contract. Prompt and
 * call-option construction happen inside the encoder's queued turn (see
 * ./turn.ts) so context assembly is serialized with the LLM call.
 */
export function runAgent(
  ctx: MimirContext,
  respond: typeof streamingResponse = streamingResponse,
) {
  const model = resolveModel(ctx.request.model);
  ctx.resolvedModel = model;
  return respond(model, ctx);
}
