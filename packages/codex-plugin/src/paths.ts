/**
 * Mimir's dedicated Codex home — ~/.mimir/codex — holding the
 * mimir-owned config.toml (MCP servers, hooks + trust ledger), the
 * AGENTS.md persona, and Codex's own session state for mimir sessions.
 * The wrapper exports CODEX_HOME to exactly this path; the env check
 * covers hooks fired inside a running session, the fallback covers
 * install-time and out-of-session invocations.
 */

import { join } from "node:path";
import { mimirHome } from "@mimir/plugin-core/util";

export const mimirCodexHome = () =>
  process.env.CODEX_HOME ?? join(mimirHome(), "codex");
