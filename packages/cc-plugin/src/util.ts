/**
 * Small shared helpers. Ported from packages/acp/src/util.ts so the rules
 * engine and MCP servers can be lifted from the monorepo with no edits.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export const parseJSON = <T>(text: string) => JSON.parse(text) as T;

/**
 * Resolve the `~/.mimir/` directory root for every state file the plugin
 * touches (logs, config, persist-state, retrieve-state, file-context-state,
 * project-paths cache, mcp.json, voice-anchor state).
 *
 * Honors `MIMIR_HOME` first. This is the only path that gets tests out of
 * a footgun: Bun's `homedir()` caches the home dir at process start and
 * silently ignores subsequent `process.env.HOME` mutations, so the
 * conventional HOME-swap test trick writes to the developer's REAL home
 * directory. Tests that need filesystem isolation set MIMIR_HOME instead.
 *
 * Containerized deployments can also pin the data dir via MIMIR_HOME.
 */
export const mimirHome = () =>
  process.env.MIMIR_HOME ?? join(homedir(), ".mimir");
