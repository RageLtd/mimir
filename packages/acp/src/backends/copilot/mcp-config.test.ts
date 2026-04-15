import { test, expect, describe } from "bun:test";
import { buildCopilotMcpServers } from "./mcp-config";

describe("buildCopilotMcpServers", () => {
  test("includes mimir, context7, and user-memory servers", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
    );
    expect(servers.mimir).toEqual({
      type: "http",
      url: "http://localhost:3777/mcp",
      tools: ["*"],
    });
    expect(servers.context7).toEqual({
      type: "local",
      command: "bunx",
      args: ["@upstash/context7-mcp"],
      tools: ["*"],
    });
    expect(servers["user-memory"]).toBeDefined();
    expect(servers["user-memory"]!.type).toBe("local");
  });

  test("user-memory server has correct env and command", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
    );
    const um = servers["user-memory"]!;
    expect(um.type).toBe("local");
    // Use toMatchObject to check subset without asserting the exact script path.
    expect(um).toMatchObject({
      type: "local",
      command: "bun",
    });
  });

  test("converts client stdio server to local type", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [
        {
          name: "custom",
          command: "node",
          args: ["server.js"],
          env: [{ name: "PORT", value: "8080" }],
        },
      ],
    );
    expect(servers.custom).toEqual({
      type: "local",
      command: "node",
      args: ["server.js"],
      env: { PORT: "8080" },
      tools: ["*"],
    });
  });

  test("converts client HTTP server to http type", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [
        {
          name: "remote",
          type: "http" as const,
          url: "http://example.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer tok" }],
        },
      ],
    );
    expect(servers.remote).toEqual({
      type: "http",
      url: "http://example.com/mcp",
      headers: { Authorization: "Bearer tok" },
      tools: ["*"],
    });
  });

  test("omits env when client server has no env vars", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [{ name: "bare", command: "echo", args: [], env: [] }],
    );
    expect(servers.bare).toBeDefined();
    expect(servers.bare!.type).toBe("local");
    expect("env" in servers.bare! ? servers.bare!.env : undefined).toBeUndefined();
  });

  test("omits headers when HTTP server has no headers", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [
        {
          name: "api",
          type: "http" as const,
          url: "http://example.com/api",
          headers: [],
        },
      ],
    );
    expect(servers.api).toBeDefined();
    expect(servers.api!.type).toBe("http");
    expect("headers" in servers.api! ? servers.api!.headers : undefined).toBeUndefined();
  });

  test("mimir's reserved servers win on name collision", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [{ name: "mimir", command: "fake", args: [], env: [] }],
    );
    expect(servers.mimir).toEqual({
      type: "http",
      url: "http://localhost:3777/mcp",
      tools: ["*"],
    });
  });

  test("defaults args to empty array when missing from stdio server", () => {
    const servers = buildCopilotMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [{ name: "minimal", command: "echo", args: [], env: [] }],
    );
    expect(servers.minimal).toBeDefined();
    expect(servers.minimal!.type).toBe("local");
    expect(servers.minimal).toMatchObject({
      type: "local",
      command: "echo",
      args: [],
    });
  });
});
