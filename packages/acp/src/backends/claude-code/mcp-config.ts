/**
 * MCP server config builder for the Claude Code SDK backend.
 *
 * Converts ACP McpServer descriptors to the record format expected by the
 * SDK's `mcpServers` option, merging the base mimir/context7/user-memory
 * servers with any client-supplied servers. Client-supplied names are
 * inserted first so mimir's reserved names always win on collision.
 */

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

const isStdioServer = (server: McpServer): server is McpServerStdio =>
  "command" in server;

/** Converts an ACP McpServer to the SDK's McpServerConfig shape. */
const acpServerToConfigEntry = (server: McpServer) => {
  if (isStdioServer(server)) {
    const env = Object.fromEntries(
      (server.env ?? []).map((e) => [e.name, e.value]),
    );
    return {
      command: server.command,
      args: server.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    } satisfies McpStdioServerConfig;
  }
  const headers = Object.fromEntries(
    (server.headers ?? []).map((h) => [h.name, h.value]),
  );
  if (server.type === "sse") {
    return {
      type: "sse",
      url: server.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    } satisfies McpSSEServerConfig;
  }
  return {
    type: "http",
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  } satisfies McpHttpServerConfig;
};

/**
 * Build the MCP server record for the SDK's `mcpServers` option.
 *
 * Merges the base mimir + context7 + user-memory servers with any
 * MCP servers provided by the ACP client. Mimir's reserved names
 * always win on collision.
 */
export const buildMcpServers = (
  serverUrl: string,
  userMemoryDbPath: string,
  clientMcpServers?: readonly McpServer[],
) => {
  // Resolve built-in MCP server scripts relative to this file.
  const userMemoryScript = new URL(
    "../../tools/user-memory-mcp.ts",
    import.meta.url,
  ).pathname;

  // Type as `Record<string, McpServerConfig>` so callers can index by
  // arbitrary client-supplied server names without TypeScript narrowing
  // the result to the literal keys defined inline below. A `satisfies`
  // clause would lock the inferred type to those literal keys and hide
  // dynamic entries (the original test failures came from this).
  const servers: Record<string, McpServerConfig> = {};

  // Client-provided servers go in first so mimir's own servers can
  // overwrite them on name collision (mimir and context7 are reserved).
  for (const server of clientMcpServers ?? []) {
    servers[server.name] = acpServerToConfigEntry(server);
  }

  servers["user-memory"] = {
    command: "bun",
    args: [userMemoryScript],
    env: { MIMIR_USER_MEMORY_DB: userMemoryDbPath },
  };
  servers.mimir = { type: "http", url: `${serverUrl}/mcp` };
  servers.context7 = { command: "bunx", args: ["@upstash/context7-mcp"] };

  return servers;
};
