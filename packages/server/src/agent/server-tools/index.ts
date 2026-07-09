import type { ToolSet } from "ai";
import { introspectionTools } from "./introspection";

/**
 * Tool-group registry — the ONE place server tool groups are wired.
 *
 * Post-MIM-88 the only surviving group is introspection (read_mimir_logs):
 * tenant memory/playbooks live in the CLIENT replica and sync as
 * ciphertext envelopes the server cannot read — there is nothing
 * org-scoped left to serve over /mcp. (Memory/playbook groups deleted in
 * MIM-88; cartographer left with MIM-91; plan/TodoWrite with MIM-89;
 * web_search removed in MIM-90.)
 */
const STATIC_GROUPS: Array<{ tools: ToolSet }> = [
  { tools: introspectionTools },
];

/** Tools exposed via /mcp to external clients (e.g. Claude Code). */
export function buildMcpPublicTools() {
  const tools: ToolSet = {};
  for (const group of STATIC_GROUPS) Object.assign(tools, group.tools);
  return tools;
}
