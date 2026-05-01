/**
 * Assemble the effective MCP server list for a session.
 *
 * Three-stage pipeline composed in one place so handlers and the `/mcp
 * reload` command share a single canonical answer to "what servers does
 * this session see?":
 *
 *   1. `loadMcpConfig(projectPath)` — read `<project>/.mcp.json` and the
 *      global `~/.mimir/mcp.json` (or `$MIMIR_MCP_CONFIG`).
 *   2. `mergeMcpServers(file, clientSupplied)` — overlay the client-supplied
 *      list (Zed's `context_servers`); client wins on name collision so
 *      Zed-UI overrides always beat file entries.
 *   3. `injectStoredTokens(merged)` — attach `Authorization: Bearer <token>`
 *      headers to HTTP servers that have a persisted access token from a
 *      prior OAuth flow.
 *
 * Three call sites use this: `session/new`, `session/load`, and `/mcp
 * reload`. Inlining in three places makes "what does session.clientMcpServers
 * actually contain" diffuse — this function names the pipeline.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { injectStoredTokens } from "./auth-injector";
import { loadMcpConfig, mergeMcpServers } from "./file-reader";

export const assembleClientMcpServers = async (
  projectPath: string,
  clientSupplied: readonly acp.McpServer[] | undefined,
) => {
  const fileServers = await loadMcpConfig(projectPath);
  const merged = mergeMcpServers(fileServers, clientSupplied);
  return injectStoredTokens(merged);
};
