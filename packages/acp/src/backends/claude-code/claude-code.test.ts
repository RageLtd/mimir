import { test, expect, describe } from "bun:test";
import { buildSdkOptions, formatContextForPrompt } from "./formatting";
import { buildMcpServers } from "./mcp-config";
import type { CCBackendConfig } from "../../config";

// ── formatContextForPrompt ──

describe("formatContextForPrompt", () => {
  test("formats messages with role labels and XML wrapper", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = formatContextForPrompt(messages);
    expect(result).toContain("<conversation_context>");
    expect(result).toContain("</conversation_context>");
    expect(result).toContain("[User]\nhello");
    expect(result).toContain("[Assistant]\nhi");
  });

  test("returns empty string for empty array", () => {
    expect(formatContextForPrompt([])).toBe("");
  });

  test("preserves multiline content", () => {
    const messages = [
      { role: "user" as const, content: "line one\nline two\nline three" },
    ];
    const result = formatContextForPrompt(messages);
    expect(result).toContain("line one\nline two\nline three");
  });

  test("preserves unicode and special characters", () => {
    const content = 'quotes "here" and émojis 🎉 and <xml> & entities';
    const messages = [{ role: "user" as const, content }];
    const result = formatContextForPrompt(messages);
    expect(result).toContain(content);
  });

  test("handles single message", () => {
    const messages = [{ role: "user" as const, content: "only" }];
    const result = formatContextForPrompt(messages);
    expect(result).toContain("[User]\nonly");
    expect(result).toContain("<conversation_context>");
  });
});

// ── buildSdkOptions ──

const baseCc: CCBackendConfig = {
  enabled: true,
  disallowedTools: [],
  permissionMode: "bypassPermissions",
  models: {},
  anchorInterval: 6,
};

describe("buildSdkOptions", () => {
  const mkOpts = (overrides?: {
    systemPrompt?: string;
    cc?: CCBackendConfig;
    model?: string;
  }) =>
    buildSdkOptions({
      systemPrompt: overrides?.systemPrompt ?? "<xml>prompt</xml>",
      cc: overrides?.cc ?? baseCc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
      model: overrides?.model,
    });

  test("appends boot instruction to system prompt (session mode)", () => {
    const opts = mkOpts();
    expect(typeof opts.systemPrompt).toBe("string");
    expect(opts.systemPrompt).toContain("<xml>prompt</xml>");
    expect(opts.systemPrompt).toContain("load_user_profile");
    expect(opts.systemPrompt).toContain("load_project_rules");
    expect(opts.systemPrompt).toContain("load_session_context");
    expect(opts.systemPrompt).toContain("At the start of this session");
  });

  test("does not append conversation context to system prompt", () => {
    const opts = mkOpts();
    expect(opts.systemPrompt as string).not.toContain("<conversation_context>");
  });

  test("system prompt is always a string (no array form with session mode)", () => {
    const opts = mkOpts();
    expect(typeof opts.systemPrompt).toBe("string");
  });

  test("sets cwd from workingDirectory", () => {
    const opts = mkOpts();
    expect(opts.cwd).toBe("/tmp/test");
  });

  test("sets permissionMode from cc config", () => {
    const opts = mkOpts();
    expect(opts.permissionMode).toBe("bypassPermissions");
  });

  test("sets allowDangerouslySkipPermissions when bypassPermissions", () => {
    const opts = mkOpts();
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
  });

  test("omits allowDangerouslySkipPermissions for other modes", () => {
    const cc = { ...baseCc, permissionMode: "plan" };
    const opts = mkOpts({ cc });
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
  });

  test("includes disallowedTools when configured", () => {
    const cc = { ...baseCc, disallowedTools: ["Agent", "Monitor"] };
    const opts = mkOpts({ cc });
    expect(opts.disallowedTools).toEqual(["Agent", "Monitor"]);
  });

  test("omits disallowedTools when list is empty", () => {
    const opts = mkOpts();
    expect(opts.disallowedTools).toBeUndefined();
  });

  test("includes model when provided", () => {
    const opts = mkOpts({ model: "opus" });
    expect(opts.model).toBe("opus");
  });

  test("omits model when not provided", () => {
    const opts = mkOpts();
    expect(opts.model).toBeUndefined();
  });

  test("does not set continue or persistSession (streaming-input mode)", () => {
    const opts = mkOpts();
    // Continuity comes from the long-lived streaming-input Query, not from
    // disk-backed JSONL replay. Setting either field would re-introduce the
    // per-turn re-send of full transcript that streamInput is meant to fix.
    expect(opts.continue).toBeUndefined();
    expect(opts.persistSession).toBeUndefined();
  });

  test("sets strictMcpConfig to true", () => {
    const opts = mkOpts();
    expect(opts.strictMcpConfig).toBe(true);
  });

  test("disables tool search via env", () => {
    const opts = mkOpts();
    expect(opts.env?.ENABLE_TOOL_SEARCH).toBe("false");
  });

  test("disables CC auto-memory injection via env", () => {
    const opts = mkOpts();
    expect(opts.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  test("hard-disables skill auto-discovery (skills: [])", () => {
    // Per SDK type docs, omitting `skills` lets the CLI's own defaults apply,
    // which is NOT "skills off." An empty array is required to enable zero
    // skills and stop the CLI loading every plugin-discovered skill into the
    // system prompt every turn.
    const opts = mkOpts();
    expect(opts.skills).toEqual([]);
  });

  test("hard-disables plugin auto-discovery (plugins: [])", () => {
    const opts = mkOpts();
    expect(opts.plugins).toEqual([]);
  });

  test("includes mcpServers", () => {
    const opts = mkOpts();
    expect(opts.mcpServers).toBeDefined();
    expect(opts.mcpServers!.mimir).toBeDefined();
  });

  test("omits maxTurns and maxBudgetUsd when not configured", () => {
    const opts = mkOpts();
    expect(opts.maxTurns).toBeUndefined();
    expect(opts.maxBudgetUsd).toBeUndefined();
  });

  test("forwards maxTurns when set on cc config", () => {
    const cc = { ...baseCc, maxTurns: 100 };
    const opts = mkOpts({ cc });
    expect(opts.maxTurns).toBe(100);
  });

  test("forwards maxBudgetUsd when set on cc config", () => {
    const cc = { ...baseCc, maxBudgetUsd: 5 };
    const opts = mkOpts({ cc });
    expect(opts.maxBudgetUsd).toBe(5);
  });
});

// ── buildMcpServers ──

describe("buildMcpServers", () => {
  test("includes mimir, context7, and user-memory servers", () => {
    const servers = buildMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
    );
    expect(servers.mimir).toEqual({
      type: "http",
      url: "http://localhost:3777/mcp",
    });
    expect(servers.context7).toEqual({
      command: "bunx",
      args: ["@upstash/context7-mcp"],
    });
    const userMemory = servers["user-memory"]!;
    expect(userMemory).toBeDefined();
    expect("command" in userMemory).toBe(true);
  });

  test("merges client stdio MCP servers", () => {
    const servers = buildMcpServers(
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
      command: "node",
      args: ["server.js"],
      env: { PORT: "8080" },
    });
    expect(servers.mimir).toBeDefined();
    expect(servers.context7).toBeDefined();
  });

  test("mimir's servers win on name collision", () => {
    const servers = buildMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [{ name: "mimir", command: "fake", args: [], env: [] }],
    );
    expect(servers.mimir).toEqual({
      type: "http",
      url: "http://localhost:3777/mcp",
    });
  });

  test("merges client SSE MCP servers", () => {
    const servers = buildMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [
        {
          name: "remote",
          type: "sse" as const,
          url: "http://example.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer tok" }],
        },
      ],
    );
    expect(servers.remote).toEqual({
      type: "sse",
      url: "http://example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });

  test("merges client HTTP MCP servers", () => {
    const servers = buildMcpServers(
      "http://localhost:3777",
      "/tmp/test-memories.db",
      [
        {
          name: "api",
          type: "http" as const,
          url: "http://example.com/api/mcp",
          headers: [],
        },
      ],
    );
    expect(servers.api).toEqual({
      type: "http",
      url: "http://example.com/api/mcp",
    });
  });
});
