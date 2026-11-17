/**
 * The boot block — `mimir-cc boot-context`'s `<boot_context>` (user profile
 * and active project) — which the `prompt.submit` hook (submit.ts) attaches
 * to the session's first prompt and to the first prompt after every reset,
 * so the developer's profile survives a compaction or `/clear`. Prior-session
 * context is not here: retrieval carries it, per turn.
 *
 * Pure: `$` never enters this file; submit.ts runs the call it shapes.
 */

import { mimirCcArgv, mimirCcInit } from "./binary";

const BOOT_TIMEOUT_MS = 15_000;

/** `$.process.run`'s argv and init for a boot-context run. */
export const bootCall = (home: string, cwd: string, sessionId: string) => ({
  argv: mimirCcArgv(home, "boot-context"),
  init: mimirCcInit({ cwd, session_id: sessionId }, BOOT_TIMEOUT_MS),
});
