import { describe, expect, test } from "bun:test";
import type { McpServer } from "@agentclientprotocol/sdk";
import { buildCodexMcpServers } from "./mcp-config";

describe("Codex MCP config", () => {
  test("forwards client stdio MCP servers", () => {
    const clientServers = [
      {
        name: "editor-tools",
        command: "zed-mcp",
        args: ["--stdio"],
        env: [{ name: "ZED_TOKEN", value: "token" }],
      },
    ] satisfies readonly McpServer[];

    const servers = buildCodexMcpServers(
      "http://localhost:3777",
      "/tmp/memories.db",
      clientServers,
    );

    expect(servers["editor-tools"]).toEqual({
      command: "zed-mcp",
      args: ["--stdio"],
      env: { ZED_TOKEN: "token" },
    });
  });

  test("uses Codex http_headers key for client HTTP MCP headers", () => {
    const clientServers = [
      {
        name: "zed",
        type: "http",
        url: "http://127.0.0.1:7777/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      },
    ] satisfies readonly McpServer[];

    const servers = buildCodexMcpServers(
      "http://localhost:3777",
      "/tmp/memories.db",
      clientServers,
    );

    expect(servers.zed).toEqual({
      url: "http://127.0.0.1:7777/mcp",
      http_headers: { Authorization: "Bearer token" },
    });
  });

  test("mimir reserved MCP server wins on client name collision", () => {
    const clientServers = [
      {
        name: "mimir",
        command: "fake",
        args: [],
        env: [],
      },
    ] satisfies readonly McpServer[];

    const servers = buildCodexMcpServers(
      "http://localhost:3777",
      "/tmp/memories.db",
      clientServers,
    );

    expect(servers.mimir).toEqual({ url: "http://localhost:3777/mcp" });
  });
});
