/**
 * Tool-definition conversion for the local turn engine (MIM-89).
 *
 * Clients hold tools as OpenAI-format definitions (the shape ACP's tool
 * manifest and MCP bridges already use). The model boundary wants
 * LanguageModelV3FunctionTool. This is the ONE $schema-strip point on the
 * client path, mirroring the server's buildTools contract.
 */

import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { ToolDefinition } from "../../tools/user-memory";

export function toolDefsToV3FunctionTools(defs: readonly ToolDefinition[]) {
  if (defs.length === 0) return undefined;

  const tools: LanguageModelV3FunctionTool[] = [];
  for (const def of defs) {
    const raw = def.function.parameters ?? {
      type: "object" as const,
      properties: {},
    };
    // Strip $schema — some providers reject it.
    const { $schema, ...cleanSchema } = raw;
    tools.push({
      type: "function",
      name: def.function.name,
      description: def.function.description ?? `Tool: ${def.function.name}`,
      inputSchema: cleanSchema as LanguageModelV3FunctionTool["inputSchema"],
    });
  }
  return tools;
}
