/**
 * `mimir-cc session-start`, which the `prompt.submit` hook (submit.ts) runs
 * off the session's first prompt: it detaches a worker that reconciles
 * keys, syncs the org replica and reindexes the project, then returns.
 * `classic.SessionStart` would carry `source`, but the engine passes it over
 * plugins a person installs where an organization manages Claude Code; the
 * binary takes a payload without `source` for a startup.
 *
 * Pure: `$` never enters this file; submit.ts runs the call it shapes.
 */

import { mimirCcCall } from "./binary";

/** The binary only parses the payload and detaches its worker. */
const SESSION_START_TIMEOUT_MS = 5_000;

/** A session-start run: its payload file, then argv and init. */
export const sessionStartCall = (
  home: string,
  cwd: string,
  sessionId: string,
) =>
  mimirCcCall(
    home,
    "session-start",
    { session_id: sessionId, cwd },
    SESSION_START_TIMEOUT_MS,
  );
