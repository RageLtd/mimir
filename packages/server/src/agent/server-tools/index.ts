import type { ToolSet } from "ai";
import type { OrgScope } from "../../db/scope";
import { externalTools } from "./external";
import { introspectionTools } from "./introspection";
import { getMcpTools } from "./mcp";
import { buildMemoryTools } from "./memory";
import { planTools } from "./plan";
import { buildPlaybookTools } from "./playbook";

/**
 * Tool-group registry — the ONE place server tool groups are wired.
 *
 * Two kinds of group:
 *  - **Scoped** (memory, playbook): rebuilt per request via a factory that
 *    closes the caller's OrgScope over each tool's execute (MIM-69). The
 *    tool() execute signature can't carry the scope, so the closure does.
 *    (Cartographer tools left with MIM-91 — they serve from the clients'
 *    local index now; code content never reaches the server.)
 *  - **Static**: groups that touch no org-scoped store at all (external MCP
 *    proxies, introspection, plan/todo).
 *
 * `mcpPublic` controls whether a group is exposed to external clients through
 * the /mcp endpoint (routes/mcp.ts, routes/tools.ts). External MCP servers'
 * tools (getMcpTools) join the server set at build time so the loop executes
 * them, but are never re-exposed over /mcp (that would proxy a remote server
 * through ours — a loop).
 *
 * Classification of a model's tool calls into server vs client happens against
 * ctx.serverTools (see agent/post-processing.ts), so there is no name-set
 * bookkeeping to refresh when MCP servers connect after boot.
 */
const SCOPED_GROUPS: Array<{
  build: (scope: OrgScope) => ToolSet;
  mcpPublic: boolean;
}> = [
  { build: buildMemoryTools, mcpPublic: true },
  { build: buildPlaybookTools, mcpPublic: true },
];

const STATIC_GROUPS: Array<{ tools: ToolSet; mcpPublic: boolean }> = [
  { tools: externalTools, mcpPublic: true },
  { tools: introspectionTools, mcpPublic: true },
  // Plan/todo tracking is loop-internal — not exposed over /mcp.
  { tools: planTools, mcpPublic: false },
];

/** All server-side tools for a request scope, including connected external
 *  MCP servers' tools. */
export function buildServerTools(scope: OrgScope) {
  const tools: ToolSet = {};
  for (const group of SCOPED_GROUPS) Object.assign(tools, group.build(scope));
  for (const group of STATIC_GROUPS) Object.assign(tools, group.tools);
  Object.assign(tools, getMcpTools());
  return tools;
}

/** Tools exposed via /mcp to external clients (e.g. Claude Code), bound to a
 *  scope. */
export function buildMcpPublicTools(scope: OrgScope) {
  const tools: ToolSet = {};
  for (const group of SCOPED_GROUPS) {
    if (group.mcpPublic) Object.assign(tools, group.build(scope));
  }
  for (const group of STATIC_GROUPS) {
    if (group.mcpPublic) Object.assign(tools, group.tools);
  }
  return tools;
}
