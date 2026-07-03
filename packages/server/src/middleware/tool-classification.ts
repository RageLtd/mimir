/**
 * Middleware 4: Tool Classification
 *
 * Converts OpenAI-format tool definitions (from client) into AI SDK v6 Tool objects.
 *
 * - Server tools: Tools with execute() — run automatically in the agent loop
 * - Client tools: Tools WITHOUT execute() — returned to client as tool_calls
 *
 * This is the ONE place we do this conversion.
 */

import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { getServerTools } from "../agent/server-tools";
import { log } from "../util/logger";
import type { MimirContext, OpenAIToolDef } from "./types";

/**
 * Client tools that are never passed to the model — blocked regardless of what the client sends.
 */
export const BLOCKED_CLIENT_TOOLS = new Set([
  "spawn_agent", // Subagents are explicitly disabled — all work happens in the main loop
]);

/**
 * Convert OpenAI-format tool definitions (from client) into AI SDK v6 Tool objects.
 *
 * Client tools get NO execute function — when the model calls them,
 * the agent loop stops and returns them as tool_calls in the response.
 */
function convertClientTools(openaiTools: OpenAIToolDef[]) {
  const tools: ToolSet = {};

  for (const t of openaiTools) {
    const fn = t.function;

    // Skip blocked tools
    if (BLOCKED_CLIENT_TOOLS.has(fn.name)) {
      log.debug({ toolName: fn.name }, "blocking client tool");
      continue;
    }

    // Pass through the client's original JSON Schema for parameters.
    // Using jsonSchema() instead of Zod avoids the broken
    // z.object({}).catchall(z.unknown()) → {properties: {}, additionalProperties: false}
    // serialization that stripped all parameter info from client tools.
    // $schema stripping happens once at the model boundary (buildTools),
    // not here — one strip, one place.
    const params = fn.parameters ?? { type: "object", properties: {} };

    tools[fn.name] = tool({
      description: fn.description ?? `Tool: ${fn.name}`,
      inputSchema: jsonSchema(params),
      // NO execute — this is what makes it a client tool.
      // The hasClientToolCall stop condition halts the agent loop
      // when the model calls one of these.
    });
  }

  return tools;
}

/**
 * Classify tools into server-side (with execute) and client-side (without).
 *
 * Server tools take priority over client tools with the same name.
 * This prevents MCP duplicates from overwriting working server-side implementations.
 */
export async function classifyTools(ctx: MimirContext) {
  const start = Date.now();

  // Server tools — defined in our codebase with execute()
  ctx.serverTools = getServerTools();

  // Client tools — from the request, no execute()
  ctx.clientTools = ctx.request.tools
    ? convertClientTools(ctx.request.tools)
    : {};

  // Merge for the model to see both
  // Server tools take priority
  ctx.allTools = { ...ctx.clientTools, ...ctx.serverTools };

  log.info(
    {
      serverTools: Object.keys(ctx.serverTools).length,
      clientTools: Object.keys(ctx.clientTools).length,
      totalTools: Object.keys(ctx.allTools).length,
      elapsed: `${Date.now() - start}ms`,
    },
    "tool classification complete",
  );
}
