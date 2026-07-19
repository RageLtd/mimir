import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { assembleClientMcpServers } from "./assemble";

const TMP = join(import.meta.dir, ".tmp-assemble-test");
const FAKE_HOME = join(TMP, "home");
const OAUTH_DIR = join(TMP, "oauth");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  mkdirSync(OAUTH_DIR, { recursive: true });
  Bun.env.HOME = FAKE_HOME;
  Bun.env.MIMIR_OAUTH_DIR = OAUTH_DIR;
  delete Bun.env.MIMIR_MCP_CONFIG;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete Bun.env.MIMIR_OAUTH_DIR;
});

const writeProjectConfig = (projectPath: string, content: object) => {
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, ".mcp.json"), JSON.stringify(content));
};

const writeStoredToken = (serverName: string, token: string) => {
  const dir = join(OAUTH_DIR, serverName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ access_token: token, token_type: "Bearer" }),
  );
};

const httpServer = (name: string, url: string): acp.McpServer => ({
  type: "http",
  name,
  url,
  headers: [],
});

describe("assembleClientMcpServers", () => {
  test("returns empty list when nothing is configured anywhere", async () => {
    const projectPath = join(TMP, "empty");
    mkdirSync(projectPath);
    const result = await assembleClientMcpServers(projectPath, undefined);
    expect(result).toEqual([]);
  });

  test("loads .mcp.json entries when no client list is supplied", async () => {
    const projectPath = join(TMP, "file-only");
    writeProjectConfig(projectPath, {
      mcpServers: {
        notion: { type: "http", url: "https://mcp.notion.com/mcp" },
      },
    });
    const result = await assembleClientMcpServers(projectPath, undefined);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("notion");
  });

  test("merges file and client lists; client wins on name collision", async () => {
    const projectPath = join(TMP, "merge");
    writeProjectConfig(projectPath, {
      mcpServers: {
        shared: { type: "http", url: "https://from-file.example.com/mcp" },
        file_only: { type: "http", url: "https://file-only.example.com/mcp" },
      },
    });
    const clientSupplied = [
      httpServer("shared", "https://from-client.example.com/mcp"),
      httpServer("client_only", "https://client-only.example.com/mcp"),
    ];
    const result = await assembleClientMcpServers(projectPath, clientSupplied);
    const byName = Object.fromEntries(result.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual([
      "client_only",
      "file_only",
      "shared",
    ]);
    expect((byName.shared as { url: string }).url).toBe(
      "https://from-client.example.com/mcp",
    );
  });

  test("injects persisted Bearer tokens onto file-loaded HTTP servers", async () => {
    const projectPath = join(TMP, "auth");
    writeProjectConfig(projectPath, {
      mcpServers: {
        notion: { type: "http", url: "https://mcp.notion.com/mcp" },
      },
    });
    writeStoredToken("notion", "ntn_persisted_abc");

    const result = await assembleClientMcpServers(projectPath, undefined);
    expect(result).toHaveLength(1);
    const server = result[0];
    if (!server || !("headers" in server)) {
      throw new Error("expected http server with headers");
    }
    expect(server.headers).toEqual([
      { name: "Authorization", value: "Bearer ntn_persisted_abc" },
    ]);
  });

  test("injects tokens onto client-supplied servers as well", async () => {
    const projectPath = join(TMP, "client-auth");
    mkdirSync(projectPath);
    writeStoredToken("github", "gh_token");

    const result = await assembleClientMcpServers(projectPath, [
      httpServer("github", "https://api.github.com/mcp"),
    ]);
    if (!result[0] || !("headers" in result[0])) {
      throw new Error("expected http server");
    }
    expect(result[0].headers).toEqual([
      { name: "Authorization", value: "Bearer gh_token" },
    ]);
  });
});
