/**
 * MCP server config builder for the Copilot SDK backend.
 *
 * Converts ACP McpServer descriptors to the record format expected by
 * the Copilot SDK's `mcpServers` session option. The Copilot SDK uses
 * `type: "local"` for stdio servers (vs CC SDK's implicit stdio default)
 * and `type: "http"` for HTTP endpoints.
 *
 * Merges the base mimir/context7/user-memory servers with any
 * client-supplied servers. Client-supplied names are inserted first
 * so mimir's reserved names always win on collision.
 */

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";

type CopilotLocalMcpServer = {
  type: "local";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools: string[];
};

type CopilotHttpMcpServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools: string[];
};

export type CopilotMcpServerConfig =
  | CopilotLocalMcpServer
  | CopilotHttpMcpServer;

const isStdioServer = (server: McpServer): server is McpServerStdio =>
  "command" in server;

/** Converts an ACP McpServer to the Copilot SDK's MCP server config shape. */
const acpServerToCopilotEntry = (server: McpServer): CopilotMcpServerConfig => {
  if (isStdioServer(server)) {
    const env = Object.fromEntries(
      (server.env ?? []).map((e) => [e.name, e.value]),
    );
    return {
      type: "local",
      command: server.command,
      args: server.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
      tools: ["*"],
    };
  }
  const headers = Object.fromEntries(
    (server.headers ?? []).map((h) => [h.name, h.value]),
  );
  return {
    type: "http",
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    tools: ["*"],
  };
};

/**
 * Build the MCP server record for the Copilot SDK's `mcpServers` option.
 *
 * Same structure as the CC backend's buildMcpServers — merges base
 * mimir + context7 + user-memory servers with client-provided ones.
 */
export const buildCopilotMcpServers = (
  serverUrl: string,
  userMemoryDbPath: string,
  clientMcpServers?: readonly McpServer[],
): Record<string, CopilotMcpServerConfig> => {
  const clientEntries: Record<string, CopilotMcpServerConfig> = {};
  for (const server of clientMcpServers ?? []) {
    clientEntries[server.name] = acpServerToCopilotEntry(server);
  }

  const userMemoryScript = new URL(
    "../../tools/user-memory-mcp.ts",
    import.meta.url,
  ).pathname;

  return {
    ...clientEntries,
    "user-memory": {
      type: "local",
      command: "bun",
      args: [userMemoryScript],
      env: { MIMIR_USER_MEMORY_DB: userMemoryDbPath },
      tools: ["*"],
    },
    mimir: {
      type: "http",
      url: `${serverUrl}/mcp`,
      tools: ["*"],
    },
    context7: {
      type: "local",
      command: "bunx",
      args: ["@upstash/context7-mcp"],
      tools: ["*"],
    },
  };
};
