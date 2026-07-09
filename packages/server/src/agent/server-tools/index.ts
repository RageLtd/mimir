import type { ToolSet } from "ai";
import type { OrgScope } from "../../db/scope";
import { externalTools } from "./external";
import { introspectionTools } from "./introspection";
import { buildMemoryTools } from "./memory";
import { buildPlaybookTools } from "./playbook";

/**
 * Tool-group registry — the ONE place server tool groups are wired.
 *
 * Post-MIM-89 the server runs no agent loop; every group here exists to
 * be exposed over /mcp to external clients (cc-plugin sessions). Two
 * kinds of group:
 *  - **Scoped** (memory, playbook): rebuilt per request via a factory that
 *    closes the caller's OrgScope over each tool's execute (MIM-69). The
 *    tool() execute signature can't carry the scope, so the closure does.
 *    (Cartographer tools left with MIM-91; plan/TodoWrite left with the
 *    loop in MIM-89 — it renders in the editor, client-side.)
 *  - **Static**: groups that touch no org-scoped store at all (web search,
 *    introspection).
 */
const SCOPED_GROUPS: Array<{
  build: (scope: OrgScope) => ToolSet;
}> = [{ build: buildMemoryTools }, { build: buildPlaybookTools }];

const STATIC_GROUPS: Array<{ tools: ToolSet }> = [
  { tools: externalTools },
  { tools: introspectionTools },
];

/** Tools exposed via /mcp to external clients (e.g. Claude Code), bound to a
 *  scope. */
export function buildMcpPublicTools(scope: OrgScope) {
  const tools: ToolSet = {};
  for (const group of SCOPED_GROUPS) Object.assign(tools, group.build(scope));
  for (const group of STATIC_GROUPS) Object.assign(tools, group.tools);
  return tools;
}
