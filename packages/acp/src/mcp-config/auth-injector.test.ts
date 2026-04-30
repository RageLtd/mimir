import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { injectStoredTokens } from "./auth-injector";

const TMP = join(import.meta.dir, ".tmp-auth-injector-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  Bun.env.MIMIR_OAUTH_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete Bun.env.MIMIR_OAUTH_DIR;
});

const writeStoredToken = (serverName: string, token: string) => {
  const dir = join(TMP, serverName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ access_token: token, token_type: "Bearer" }),
  );
};

const httpServer = (
  name: string,
  headers: acp.HttpHeader[] = [],
): acp.McpServer => ({
  type: "http",
  name,
  url: `https://${name}.example.com/mcp`,
  headers,
});

const stdioServer = (name: string): acp.McpServer => ({
  name,
  command: "/usr/bin/echo",
  args: [],
  env: [],
});

describe("injectStoredTokens", () => {
  test("attaches Bearer header to HTTP server with persisted token", async () => {
    writeStoredToken("notion", "ntn_abc");
    const servers = [httpServer("notion")];
    const result = await injectStoredTokens(servers);
    expect(result).toHaveLength(1);
    const updated = result[0];
    if (!updated || !("headers" in updated)) {
      throw new Error("expected http server with headers");
    }
    expect(updated.headers).toEqual([
      { name: "Authorization", value: "Bearer ntn_abc" },
    ]);
  });

  test("preserves existing static Authorization header", async () => {
    writeStoredToken("notion", "from-disk");
    const servers = [
      httpServer("notion", [
        { name: "Authorization", value: "Bearer static-token" },
      ]),
    ];
    const result = await injectStoredTokens(servers);
    if (!result[0] || !("headers" in result[0])) {
      throw new Error("expected http server");
    }
    expect(result[0].headers).toEqual([
      { name: "Authorization", value: "Bearer static-token" },
    ]);
  });

  test("preserves stdio servers untouched", async () => {
    writeStoredToken("notion", "ntn_abc");
    const servers = [stdioServer("notion"), httpServer("github")];
    const result = await injectStoredTokens(servers);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(stdioServer("notion"));
  });

  test("leaves HTTP servers without persisted tokens unchanged", async () => {
    const servers = [httpServer("unauthed")];
    const result = await injectStoredTokens(servers);
    if (!result[0] || !("headers" in result[0])) {
      throw new Error("expected http server");
    }
    expect(result[0].headers).toEqual([]);
  });

  test("appends Bearer alongside existing non-auth headers", async () => {
    writeStoredToken("svc", "tok");
    const servers = [
      httpServer("svc", [{ name: "X-Custom", value: "foo" }]),
    ];
    const result = await injectStoredTokens(servers);
    if (!result[0] || !("headers" in result[0])) {
      throw new Error("expected http server");
    }
    expect(result[0].headers).toEqual([
      { name: "X-Custom", value: "foo" },
      { name: "Authorization", value: "Bearer tok" },
    ]);
  });

  test("static auth check is case-insensitive", async () => {
    writeStoredToken("svc", "from-disk");
    const servers = [
      httpServer("svc", [
        { name: "authorization", value: "Bearer existing" },
      ]),
    ];
    const result = await injectStoredTokens(servers);
    if (!result[0] || !("headers" in result[0])) {
      throw new Error("expected http server");
    }
    // Should NOT inject — existing lowercase 'authorization' wins.
    expect(result[0].headers).toEqual([
      { name: "authorization", value: "Bearer existing" },
    ]);
  });
});

