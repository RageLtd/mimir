/**
 * Per-turn preparation — runs INSIDE the LLM-call queue.
 *
 * Context assembly writes the client's trailing turn to the global log and
 * reads the last-N window back out. If that happened at route time (as the
 * rest of the middleware does), a request arriving while another turn is
 * streaming would snapshot the log before the in-flight assistant reply
 * exists — the model would be handed a history missing the previous answer.
 *
 * Keeping assembly here makes persist → read → infer → persist one atomic
 * unit per queued turn: by the time this runs, every prior turn's assistant
 * output is already in the log.
 */

import { assembleContext } from "../../middleware/context-assembly";
import type { MimirContext } from "../../middleware/types";
import { buildPrompt } from "./prompt";
import { buildCallOptions, buildTools } from "./tools";

export async function prepareTurn(ctx: MimirContext) {
  await assembleContext(ctx);
  return buildCallOptions(ctx, buildPrompt(ctx), buildTools(ctx));
}
