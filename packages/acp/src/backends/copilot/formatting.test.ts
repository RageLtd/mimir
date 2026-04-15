import { test, expect, describe } from "bun:test";
import {
  formatContextForPrompt,
  buildCopilotSessionOptions,
} from "./formatting";
import type { CopilotBackendConfig } from "../../config";

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

// ── buildCopilotSessionOptions ──

const baseCopilot: CopilotBackendConfig = {
  enabled: true,
  defaultModel: "gpt-4o",
  workingDirectory: undefined,
};

describe("buildCopilotSessionOptions", () => {
  const mkOpts = (overrides?: {
    contextMessages?: { role: "user" | "assistant"; content: string }[];
    systemPrompt?: string;
    copilot?: CopilotBackendConfig;
    model?: string;
  }) =>
    buildCopilotSessionOptions({
      contextMessages: overrides?.contextMessages ?? [
        { role: "user" as const, content: "prev" },
      ],
      systemPrompt: overrides?.systemPrompt ?? "base system prompt",
      copilot: overrides?.copilot ?? baseCopilot,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
      model: overrides?.model,
    });

  test("concatenates context into system message content", () => {
    const opts = mkOpts();
    expect(opts.systemMessage.content).toContain("base system prompt");
    expect(opts.systemMessage.content).toContain("<conversation_context>");
    expect(opts.systemMessage.content).toContain("[User]\nprev");
  });

  test("omits context when messages are empty", () => {
    const opts = mkOpts({ contextMessages: [] });
    expect(opts.systemMessage.content).toBe("base system prompt");
    expect(opts.systemMessage.content).not.toContain("<conversation_context>");
  });

  test("uses replace mode for system message", () => {
    const opts = mkOpts();
    expect(opts.systemMessage.mode).toBe("replace");
  });

  test("sets streaming to true", () => {
    const opts = mkOpts();
    expect(opts.streaming).toBe(true);
  });

  test("uses explicit model when provided", () => {
    const opts = mkOpts({ model: "claude-sonnet-4" });
    expect(opts.model).toBe("claude-sonnet-4");
  });

  test("falls back to defaultModel when model is not provided", () => {
    const opts = mkOpts();
    expect(opts.model).toBe("gpt-4o");
  });

  test("sets workingDirectory from options", () => {
    const opts = mkOpts();
    expect(opts.workingDirectory).toBe("/tmp/test");
  });

  test("includes MCP servers in session options", () => {
    const opts = mkOpts();
    expect(opts.mcpServers).toBeDefined();
    expect(opts.mcpServers.mimir).toBeDefined();
    expect(opts.mcpServers.context7).toBeDefined();
    expect(opts.mcpServers["user-memory"]).toBeDefined();
  });

  test("onPermissionRequest always approves", async () => {
    const opts = mkOpts();
    const result = await opts.onPermissionRequest();
    expect(result).toEqual({ kind: "approved" });
  });

  test("merges client MCP servers into session options", () => {
    const opts = buildCopilotSessionOptions({
      contextMessages: [],
      systemPrompt: "prompt",
      copilot: baseCopilot,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
      clientMcpServers: [
        { name: "custom", command: "node", args: ["srv.js"], env: [] },
      ],
    });
    expect(opts.mcpServers.custom).toBeDefined();
    expect(opts.mcpServers.mimir).toBeDefined();
  });
});
