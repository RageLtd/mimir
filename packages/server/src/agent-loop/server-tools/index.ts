import type { ToolSet } from "ai";
import { approvalTools } from "./approval";
import { cartographerTools } from "./cartographer";
import { externalTools } from "./external";
import { introspectionTools } from "./introspection";
import { getMcpToolNames, getMcpTools } from "./mcp";
import { memoryTools } from "./memory";

/** All server-side tool names — used to filter from client streams */
export const SERVER_TOOL_NAMES = new Set([
  ...Object.keys(memoryTools),
  ...Object.keys(cartographerTools),
  ...Object.keys(externalTools),
  ...Object.keys(approvalTools),
  ...Object.keys(introspectionTools),
  // MCP tool names are added dynamically after boot
]);

/** Refresh the SERVER_TOOL_NAMES set after MCP tools are loaded */
export function refreshToolNames(): void {
  for (const name of getMcpToolNames()) {
    SERVER_TOOL_NAMES.add(name);
  }
}

/** Type for individual tool names from each category */
export type MemoryToolName = keyof typeof memoryTools;
export type CartographerToolName = keyof typeof cartographerTools;
export type ExternalToolName = keyof typeof externalTools;

/** Type for individual tool names from approval category */
export type ApprovalToolName = keyof typeof approvalTools;

/** Union of all server-side tool names */
export type ServerToolName =
  | MemoryToolName
  | CartographerToolName
  | ExternalToolName
  | ApprovalToolName
  | string; // MCP tools have dynamic names

/** Type for the server tools record */
export type ServerTools = ToolSet;

/** Combined server tools with prompt caching enabled */
export const getServerTools = (): ServerTools => ({
  ...memoryTools,
  ...cartographerTools,
  ...externalTools,
  ...approvalTools,
  ...introspectionTools,
  ...getMcpTools(),
});

/**
 * Tools exposed via the /mcp endpoint to external clients (e.g. Claude Code).
 * Excludes approvalTools (internal agent-loop workflow) and getMcpTools()
 * (already remote MCP servers — re-exposing them would create a loop).
 * Add new public tool groups here and they appear in /mcp automatically.
 */
export const getMcpPublicTools = (): ServerTools => ({
  ...memoryTools,
  ...cartographerTools,
  ...externalTools,
  ...introspectionTools,
});
