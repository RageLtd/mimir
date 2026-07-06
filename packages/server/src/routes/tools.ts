/**
 * Tools Manifest Endpoint
 *
 * GET /v1/tools
 *
 * Returns the list of server-side tools available to the agent.
 * mimir-acp fetches this to build its ACP tool manifest, combining
 * server tools + client tools + local user memory tools.
 *
 * Tool definitions are generated dynamically from getMcpPublicTools()
 * so the manifest stays in sync with the actual server-side tool set.
 * Internal tools (approval) and dynamic MCP tools (to avoid loops)
 * are excluded.
 */

import { asSchema } from "ai";
import { Hono } from "hono";
import { buildMcpPublicTools } from "../agent/server-tools";
import { rootScope } from "../db/scope";
import { getDb } from "../db/surreal";

export const tools = new Hono();

/** A scope for enumeration only — this route lists tool schemas and never
 *  invokes execute, so the connection is never used for a scoped query. */
async function listingScope() {
  return rootScope(await getDb());
}

/**
 * OpenAI-compatible tool definition.
 * Matches the ToolDefinition type from mimir-acp.
 */
type ToolDef = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

/**
 * Convert an AI SDK ToolSet to OpenAI-format tool definitions.
 * Strips execute functions and converts Zod/jsonSchema inputs to plain JSON Schema.
 * Callers should pass getMcpPublicTools() which already excludes internal
 * and loop-prone tool groups (approval, MCP).
 */
function toolSetToOpenAI(
  toolSet: ReturnType<typeof buildMcpPublicTools>,
): ToolDef[] {
  return Object.entries(toolSet).map(([name, toolDef]) => {
    const schema = asSchema(toolDef.inputSchema);
    // Strip $schema from the JSON Schema — it's not needed by consumers
    // and can cause validation issues with some providers.
    const { $schema, ...parameters } = schema.jsonSchema as Record<
      string,
      unknown
    >;

    return {
      type: "function" as const,
      function: {
        name,
        description: toolDef.description ?? `Tool: ${name}`,
        parameters,
      },
    };
  });
}

/**
 * GET /v1/tools
 *
 * Returns the server tool manifest.
 */
tools.get("/", async (c) => {
  const publicTools = buildMcpPublicTools(await listingScope());
  return c.json(toolSetToOpenAI(publicTools));
});

/**
 * GET /v1/tools/:name
 *
 * Returns a specific tool definition by name.
 */
tools.get("/:name", async (c) => {
  const name = c.req.param("name");
  const publicTools = buildMcpPublicTools(await listingScope());
  const manifest = toolSetToOpenAI(publicTools);
  const tool = manifest.find((t) => t.function.name === name);

  if (!tool) {
    return c.json({ error: `Tool not found: ${name}` }, 404);
  }

  return c.json(tool);
});
