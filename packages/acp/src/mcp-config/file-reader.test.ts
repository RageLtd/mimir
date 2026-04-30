import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMcpConfig, mergeMcpServers } from "./file-reader";

const TMP = join(import.meta.dir, ".tmp-mcp-config-test");
const FAKE_HOME = join(TMP, "home");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  // Redirect $HOME for the global config lookup so tests don't read the
  // developer's real ~/.mimir/mcp.json.
  Bun.env.HOME = FAKE_HOME;
  delete Bun.env.MIMIR_MCP_CONFIG;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const writeProjectConfig = (projectPath: string, content: object) => {
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, ".mcp.json"), JSON.stringify(content));
};

const writeGlobalConfig = (content: object) => {
  mkdirSync(join(FAKE_HOME, ".mimir"), { recursive: true });
  writeFileSync(
    join(FAKE_HOME, ".mimir", "mcp.json"),
    JSON.stringify(content),
  );
};

describe("loadMcpConfig", () => {
  test("returns empty array when no config files exist", async () => {
    const projectPath = join(TMP, "empty-project");
    mkdirSync(projectPath);
    const servers = await loadMcpConfig(projectPath);
    expect(servers).toEqual([]);
  });

  test("reads stdio server from project .mcp.json", async () => {
    const projectPath = join(TMP, "stdio-project");
    writeProjectConfig(projectPath, {
      mcpServers: {
        notion: {
          command: "bunx",
          args: ["@notionhq/notion-mcp-server"],
          env: { NOTION_TOKEN: "ntn_xxx" },
        },
      },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      name: "notion",
      command: "bunx",
      args: ["@notionhq/notion-mcp-server"],
      env: [{ name: "NOTION_TOKEN", value: "ntn_xxx" }],
    });
  });

  test("reads http server with headers", async () => {
    const projectPath = join(TMP, "http-project");
    writeProjectConfig(projectPath, {
      mcpServers: {
        custom: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer abc" },
        },
      },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      type: "http",
      name: "custom",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer abc" }],
    });
  });

  test("reads sse server when type is sse", async () => {
    const projectPath = join(TMP, "sse-project");
    writeProjectConfig(projectPath, {
      mcpServers: {
        events: { type: "sse", url: "https://example.com/sse" },
      },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      type: "sse",
      name: "events",
      url: "https://example.com/sse",
      headers: [],
    });
  });

  test("defaults remote shape to http when type is missing", async () => {
    const projectPath = join(TMP, "default-http-project");
    writeProjectConfig(projectPath, {
      mcpServers: { remote: { url: "https://example.com/mcp" } },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers[0]).toMatchObject({ type: "http", name: "remote" });
  });

  test("defaults stdio args and env to empty when omitted", async () => {
    const projectPath = join(TMP, "minimal-stdio");
    writeProjectConfig(projectPath, {
      mcpServers: { tool: { command: "/usr/bin/tool" } },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers[0]).toEqual({
      name: "tool",
      command: "/usr/bin/tool",
      args: [],
      env: [],
    });
  });

  test("merges global and project configs (project wins on collision)", async () => {
    const projectPath = join(TMP, "merge-project");
    writeGlobalConfig({
      mcpServers: {
        global_only: { command: "global", args: ["g"] },
        shared: { command: "global-version", args: [] },
      },
    });
    writeProjectConfig(projectPath, {
      mcpServers: {
        project_only: { command: "project", args: ["p"] },
        shared: { command: "project-version", args: [] },
      },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers).toHaveLength(3);
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.global_only).toMatchObject({ command: "global" });
    expect(byName.project_only).toMatchObject({ command: "project" });
    expect(byName.shared).toMatchObject({ command: "project-version" });
  });

  test("respects $MIMIR_MCP_CONFIG override for the global path", async () => {
    const customPath = join(TMP, "elsewhere", "mcp.json");
    mkdirSync(join(TMP, "elsewhere"));
    writeFileSync(
      customPath,
      JSON.stringify({
        mcpServers: { custom: { command: "from-env", args: [] } },
      }),
    );
    Bun.env.MIMIR_MCP_CONFIG = customPath;

    const projectPath = join(TMP, "env-project");
    mkdirSync(projectPath);
    const servers = await loadMcpConfig(projectPath);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("custom");
  });

  test("skips entries with neither command nor url", async () => {
    const projectPath = join(TMP, "broken-project");
    writeProjectConfig(projectPath, {
      mcpServers: {
        broken: { foo: "bar" },
        valid: { command: "ok", args: [] },
      },
    });

    const servers = await loadMcpConfig(projectPath);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("valid");
  });

  test("skips entries with invalid env type", async () => {
    const projectPath = join(TMP, "bad-env");
    writeProjectConfig(projectPath, {
      mcpServers: {
        broken: { command: "x", args: [], env: { KEY: 123 } },
      },
    });
    const servers = await loadMcpConfig(projectPath);
    expect(servers).toEqual([]);
  });

  test("returns empty list and does not throw on malformed JSON", async () => {
    const projectPath = join(TMP, "broken-json");
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, ".mcp.json"), "{ not valid json");
    const servers = await loadMcpConfig(projectPath);
    expect(servers).toEqual([]);
  });

  test("returns empty list when mcpServers key is missing", async () => {
    const projectPath = join(TMP, "no-key");
    writeProjectConfig(projectPath, { other: "field" });
    const servers = await loadMcpConfig(projectPath);
    expect(servers).toEqual([]);
  });
});

describe("mergeMcpServers", () => {
  test("returns file servers when no client servers", () => {
    const file = [{ name: "a", command: "a", args: [], env: [] }];
    expect(mergeMcpServers(file, undefined)).toEqual(file);
  });

  test("appends client servers when no name collision", () => {
    const file = [{ name: "a", command: "a", args: [], env: [] }];
    const client = [{ name: "b", command: "b", args: [], env: [] }];
    const merged = mergeMcpServers(file, client);
    expect(merged.map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("client servers win on name collision", () => {
    const file = [{ name: "shared", command: "from-file", args: [], env: [] }];
    const client = [
      { name: "shared", command: "from-client", args: [], env: [] },
    ];
    const merged = mergeMcpServers(file, client);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ command: "from-client" });
  });
});
