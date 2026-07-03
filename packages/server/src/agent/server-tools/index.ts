import type { ToolSet } from "ai";
import { cartographerTools } from "./cartographer";
import { externalTools } from "./external";
import { introspectionTools } from "./introspection";
import { getMcpTools } from "./mcp";
import { memoryTools } from "./memory";
import { planTools } from "./plan";
import { playbookTools } from "./playbook";

/**
 * Tool-group registry — the ONE place server tool groups are wired.
 *
 * Adding a tool group means adding one entry here; everything else is
 * derived. `mcpPublic` controls whether the group is exposed to external
 * clients through the /mcp endpoint (routes/mcp.ts, routes/tools.ts).
 *
 * External MCP servers' tools (getMcpTools) are deliberately NOT in the
 * registry: they join getServerTools() at merge time so the loop executes
 * them, but re-exposing them over /mcp would proxy a remote server through
 * ours — a loop.
 *
 * Classification of a model's tool calls into server vs client happens
 * against ctx.serverTools (see agent/post-processing.ts), so there is
 * no name-set bookkeeping to refresh when MCP servers connect after boot.
 */
const TOOL_GROUPS: Array<{ tools: ToolSet; mcpPublic: boolean }> = [
  { tools: memoryTools, mcpPublic: true },
  { tools: playbookTools, mcpPublic: true },
  { tools: cartographerTools, mcpPublic: true },
  { tools: externalTools, mcpPublic: true },
  { tools: introspectionTools, mcpPublic: true },
  // Plan/todo tracking is loop-internal — not exposed over /mcp.
  { tools: planTools, mcpPublic: false },
];

/** All server-side tools, including connected external MCP servers' tools. */
export const getServerTools = () => {
  const tools: ToolSet = {};
  for (const group of TOOL_GROUPS) {
    Object.assign(tools, group.tools);
  }
  Object.assign(tools, getMcpTools());
  return tools;
};

/** Tools exposed via the /mcp endpoint to external clients (e.g. Claude Code). */
export const getMcpPublicTools = () => {
  const tools: ToolSet = {};
  for (const group of TOOL_GROUPS) {
    if (group.mcpPublic) Object.assign(tools, group.tools);
  }
  return tools;
};
