/**
 * MCP server config builder for the Codex app-server backend.
 *
 * Codex receives MCP configuration through `--config mcp_servers.*` entries.
 * The app-server accepts the same nested config object on `thread/start`, so
 * we keep this as a plain JSON/TOML-compatible record.
 */

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | CodexConfigObject;

type CodexConfigObject = {
  [key: string]: CodexConfigValue;
};

export type CodexMcpServerConfig = CodexConfigObject;

const isStdioServer = (server: McpServer): server is McpServerStdio =>
  "command" in server;

const envRecord = (
  entries: readonly { name: string; value: string }[] | undefined,
) => {
  const env: Record<string, string> = {};
  for (const entry of entries ?? []) {
    env[entry.name] = entry.value;
  }
  return env;
};

const headerRecord = (
  entries: readonly { name: string; value: string }[] | undefined,
) => {
  const headers: Record<string, string> = {};
  for (const entry of entries ?? []) {
    headers[entry.name] = entry.value;
  }
  return headers;
};

const acpServerToCodexEntry = (server: McpServer): CodexMcpServerConfig => {
  if (isStdioServer(server)) {
    const env = envRecord(server.env);
    return {
      command: server.command,
      args: server.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const headers = headerRecord(server.headers);
  return {
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { http_headers: headers } : {}),
  };
};

export const buildCodexMcpServers = (
  serverUrl: string,
  userMemoryDbPath: string,
  workingDirectory: string,
  clientMcpServers?: readonly McpServer[],
) => {
  const userMemoryScript = new URL(
    "../../tools/user-memory-mcp.ts",
    import.meta.url,
  ).pathname;

  const servers: CodexConfigObject = {};
  for (const server of clientMcpServers ?? []) {
    servers[server.name] = acpServerToCodexEntry(server);
  }

  servers["user-memory"] = {
    command: "bun",
    args: [userMemoryScript],
    env: { MIMIR_USER_MEMORY_DB: userMemoryDbPath },
  };
  servers.mimir = { url: `${serverUrl}/mcp` };
  servers.context7 = { command: "bunx", args: ["@upstash/context7-mcp"] };
  servers.filesystem = {
    command: "bunx",
    args: ["@modelcontextprotocol/server-filesystem", workingDirectory, "/tmp"],
  };

  return servers;
};
