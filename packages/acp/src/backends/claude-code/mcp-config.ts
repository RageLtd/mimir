/**
 * MCP config builder for the Claude Code backend.
 *
 * Converts ACP McpServer descriptors to the JSON format expected by
 * `claude --mcp-config`, merging the base mimir/context7/user-memory
 * servers with any client-supplied servers. Client-supplied names are
 * written first so mimir's reserved names always win on collision.
 */

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";

const isStdioServer = (server: McpServer): server is McpServerStdio =>
  "command" in server;

/** Converts an ACP McpServer to the entry format CC's --mcp-config expects. */
const acpServerToConfigEntry = (server: McpServer): Record<string, unknown> => {
  if (isStdioServer(server)) {
    const env = Object.fromEntries(
      (server.env ?? []).map((e) => [e.name, e.value]),
    );
    return {
      type: "stdio",
      command: server.command,
      args: server.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  const headers = Object.fromEntries(
    (server.headers ?? []).map((h) => [h.name, h.value]),
  );
  return {
    type: server.type,
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
};

/**
 * Writes the MCP config file consumed by `--mcp-config`, merging the base
 * mimir + context7 servers with any MCP servers provided by the ACP client.
 *
 * Pass a session-specific `mcpConfigPath` when client servers differ per
 * session to avoid concurrent sessions overwriting each other's config.
 */
export const writeMcpConfig = async (
  mcpConfigPath: string,
  serverUrl: string,
  userMemoryDbPath: string,
  clientMcpServers?: readonly McpServer[],
): Promise<void> => {
  const clientEntries: Record<string, unknown> = {};
  for (const server of clientMcpServers ?? []) {
    clientEntries[server.name] = acpServerToConfigEntry(server);
  }

  // Resolve the user-memory MCP server script relative to this file.
  const userMemoryScript = new URL(
    "../../tools/user-memory-mcp.ts",
    import.meta.url,
  ).pathname;

  const config = {
    mcpServers: {
      // Client-provided servers first so mimir's own servers always win on
      // name collision (mimir and context7 are reserved names).
      ...clientEntries,
      "user-memory": {
        type: "stdio",
        command: "bun",
        args: [userMemoryScript],
        env: { MIMIR_USER_MEMORY_DB: userMemoryDbPath },
      },
      mimir: {
        type: "http",
        url: `${serverUrl}/mcp`,
      },
      context7: {
        type: "stdio",
        command: "bunx",
        args: ["@upstash/context7-mcp"],
      },
    },
  };
  await Bun.write(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`);
};
