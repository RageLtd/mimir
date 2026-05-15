/**
 * Middleware 2.5: User Context Injection
 *
 * Reads `metadata.user_context` from the request — a complete
 * `<user_context>` XML block containing `<user_profile>` and
 * `<user_memories>` sections, built client-side by mimir-acp from its
 * local sqlite store. Appended to `ctx.memories` so MW3 includes it in
 * the context injection alongside summaries and goldfish memories.
 *
 * Runs after MW2 (Goldfish) and before MW3 (Context Assembly).
 */

import { log } from "../util/logger";
import type { MimirContext } from "./types";

export function injectUserProfile(ctx: MimirContext) {
  const userContext = ctx.request.metadata?.user_context as string | undefined;
  if (!userContext) {
    log.debug("no user_context in metadata, skipping injection");
    return;
  }

  ctx.memories = ctx.memories
    ? `${ctx.memories}\n\n${userContext}`
    : userContext;
  log.info(
    { blockLength: userContext.length },
    "user context injected",
  );
}
