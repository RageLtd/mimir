/**
 * MCP server config builder for the Claude Code SDK backend.
 *
 * Converts ACP McpServer descriptors to the record format expected by
 * the SDK's `mcpServers` option, merging the base mimir/context7/user-memory
 * servers with any client-supplied servers. Client-supplied names are
 * inserted first so mimir's reserved names always win on collision.
 */

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import type {
  McpHttpServerConfig,
  McpSdkServerConfigWithInstance,
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
  bootServer?: McpSdkServerConfigWithInstance,
) => {
  const clientEntries: Record<string, McpServerConfig> = {};
  for (const server of clientMcpServers ?? []) {
    clientEntries[server.name] = acpServerToConfigEntry(server);
  }

  // Resolve built-in MCP server scripts relative to this file.
  const userMemoryScript = new URL(
    "../../tools/user-memory-mcp.ts",
    import.meta.url,
  ).pathname;

  return {
    // Client-provided servers first so mimir's own servers always win on
    // name collision (mimir and context7 are reserved names).
    ...clientEntries,
    "user-memory": {
      command: "bun",
      args: [userMemoryScript],
      env: { MIMIR_USER_MEMORY_DB: userMemoryDbPath },
    },
    mimir: {
      type: "http",
      url: `${serverUrl}/mcp`,
    },
    context7: {
      command: "bunx",
      args: ["@upstash/context7-mcp"],
    },
    // Boot server delivers per-session context (user profile, session
    // history, project rules) as tool results on the first turn.
    ...(bootServer ? { [bootServer.name]: bootServer } : {}),
  } satisfies Record<string, McpServerConfig>;
};
