/**
 * Small shared helpers. Originally from packages/cc-plugin/src/util.ts —
 * lifted into the shared layer because every Mimir adapter (CC plugin,
 * ACP adapter, future OC plugin) needs `mimirHome`, error-message
 * extraction, and JSON-with-type parsing. Nothing here references a
 * specific protocol.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Extract a human-readable message from an unknown thrown value. Used
 * everywhere we log a caught error — `catch (err)` binds to `unknown`
 * in strict TS, and `String(err)` calls `toString()` which produces
 * useless output for non-Error throws.
 */
export const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Parse JSON with a typed return. This is the single boundary where
 * untyped JSON enters the type system — the caller is responsible for
 * ensuring the shape matches T. Inherent to JSON.parse; would need a
 * runtime schema validator to do better.
 */
export const parseJSON = <T>(text: string) => JSON.parse(text) as T;

/**
 * Resolve the `~/.mimir/` directory root for every state file the
 * adapters touch (logs, config, persist-state, retrieve-state,
 * file-context-state, project-paths cache, mcp.json, voice-anchor state).
 *
 * Honors `MIMIR_HOME` first. This is the only path that gets tests out
 * of a footgun: Bun's `homedir()` caches the home dir at process start
 * and silently ignores subsequent `process.env.HOME` mutations, so the
 * conventional HOME-swap test trick writes to the developer's REAL home
 * directory. Tests that need filesystem isolation set MIMIR_HOME instead.
 *
 * Containerized deployments can also pin the data dir via MIMIR_HOME.
 */
export const mimirHome = () =>
  process.env.MIMIR_HOME ?? join(homedir(), ".mimir");
