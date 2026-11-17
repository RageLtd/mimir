/**
 * The boot block — `mimir-cc boot-context`'s `<boot_context>` (user profile
 * and active project) — which the `prompt.submit` hook (submit.ts) attaches
 * to the session's first prompt and to the first prompt after every reset,
 * so the developer's profile survives a compaction or `/clear`. Prior-session
 * context is not here: retrieval carries it, per turn.
 *
 * Pure: `$` never enters this file; submit.ts runs the call it shapes.
 */

import { mimirCcCall } from "./binary";

const BOOT_TIMEOUT_MS = 15_000;

/** A boot-context run: its payload file, then argv and init. */
export const bootCall = (home: string, cwd: string, sessionId: string) =>
  mimirCcCall(
    home,
    "boot-context",
    { cwd, session_id: sessionId },
    BOOT_TIMEOUT_MS,
  );
