/**
 * Middleware 2.5: User Profile Injection
 *
 * Reads `metadata.userProfile` from the request and appends it to the
 * memories context block. This is static user facts that should always
 * be present — unlike MW2's retrieved memories which are query-dependent.
 *
 * Runs after MW2 (Goldfish) and before MW3 (Context Assembly).
 * The profile text is appended to ctx.memories so MW3 includes it
 * in the context injection.
 */

import { log } from "../util/logger";
import type { MimirContext } from "./types";

/**
 * Inject user profile into memories if present in request metadata.
 * Profile is appended after retrieved memories (if any).
 */
export function injectUserProfile(ctx: MimirContext) {
  const start = Date.now();

  const profile = ctx.request.metadata?.userProfile as string | undefined;

  if (!profile) {
    log.debug("no user profile in metadata, skipping injection");
    return;
  }

  // Append profile to memories (or create if MW2 returned null)
  const profileBlock = `<user_profile>\n${profile}\n</user_profile>`;
  ctx.memories = ctx.memories
    ? `${ctx.memories}\n\n${profileBlock}`
    : profileBlock;

  log.info(
    {
      profileLength: profile.length,
      hasRetrievedMemories: !!ctx.memories && ctx.memories !== profileBlock,
      elapsed: `${Date.now() - start}ms`,
    },
    "user profile injected",
  );
}
