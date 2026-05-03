import { describe, expect, test } from "bun:test";
import type { CCBackendConfig } from "../../config";
import { toAnthropicXml } from "../../utils/markdown-to-xml";
import { buildSdkOptions, formatContextForPrompt } from "./formatting";

// ── End-to-end pipeline: server response → SDK options ──
//
// Simulates the full flow: the server's /v1/context/assemble returns a
// systemPrompt + messages array. prompt-cc strips the current user
// message, converts the system prompt to XML, and the assembled context
// flows through the load_session_context boot tool result. The system
// prompt itself stays free of conversation history.

describe("end-to-end: assembled context → claude args + context", () => {
  const serverSystemPrompt =
    "# Critical Rules\nFollow instructions.\n# Identity and Voice\nBe direct.";
  const currentQuery = "What does the auth module do?";

  const assembledMessages = [
    {
      role: "user" as const,
      content:
        "Session context:\n<summaries>\n[Summary 1]\nUser asked about auth.\n</summaries>\n\n<memories>\nUser prefers concise answers.\n</memories>",
    },
    { role: "assistant" as const, content: "Understood." },
    { role: "user" as const, content: "Tell me about the project" },
    {
      role: "assistant" as const,
      content: "This is a TypeScript monorepo with two packages.",
    },
    { role: "user" as const, content: currentQuery },
  ];

  test("formatContextForPrompt produces structured text", () => {
    const priorMessages = assembledMessages.slice(0, -1);
    const text = formatContextForPrompt(priorMessages);

    expect(text).toContain("<conversation_context>");
    expect(text).toContain("</conversation_context>");
    expect(text).toContain("[User]");
    expect(text).toContain("[Assistant]");
    expect(text).toContain("Session context:");
    expect(text).toContain("Understood.");
    expect(text).toContain("Tell me about the project");
    expect(text).not.toContain(currentQuery);
  });

  test("formatContextForPrompt returns empty string for no context", () => {
    expect(formatContextForPrompt([])).toBe("");
  });

  test("system prompt is converted to XML with injected blocks", () => {
    const xml = toAnthropicXml(serverSystemPrompt);

    expect(xml).toContain("<critical_rules>");
    expect(xml).toContain("</critical_rules>");
    expect(xml).toContain("<identity_and_voice>");

    expect(xml).toContain("<environment>");
    expect(xml).toContain("<model_override>");

    expect(xml).toContain("Follow instructions.");
    expect(xml).toContain("Be direct.");
  });

  test("buildSdkOptions appends boot instruction and passes model/disallowedTools", () => {
    const xmlPrompt = toAnthropicXml(serverSystemPrompt);
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: ["Agent", "Monitor"],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
    };

    const opts = buildSdkOptions({
      systemPrompt: xmlPrompt,
      cc,
      model: "opus",
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });

    expect(opts.systemPrompt).toContain(xmlPrompt);
    expect(opts.systemPrompt).toContain("load_user_profile");
    expect(opts.systemPrompt).toContain("load_project_rules");
    expect(opts.systemPrompt).toContain("load_session_context");
    expect(opts.systemPrompt).toContain("At the start of this session");

    expect(opts.model).toBe("opus");
    expect(opts.disallowedTools).toEqual(["Agent", "Monitor"]);
  });

  test("system prompt always includes boot instruction even on first message", () => {
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
    };
    const opts = buildSdkOptions({
      systemPrompt: "<system/>",
      cc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });

    expect(opts.systemPrompt).toContain("load_user_profile");
    expect(opts.systemPrompt).toContain("load_project_rules");
    expect(opts.systemPrompt).toContain("load_session_context");
    expect(opts.systemPrompt).toContain("At the start of this session");
  });

  // The system prompt is fed verbatim — boot instruction is appended.
  // Session context flows through the load_session_context boot tool.
  test("buildSdkOptions does not inject conversation history into the system prompt", () => {
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
    };
    const xmlPrompt = toAnthropicXml(serverSystemPrompt);

    const opts = buildSdkOptions({
      systemPrompt: xmlPrompt,
      cc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });

    if (typeof opts.systemPrompt !== "string") {
      throw new Error("expected systemPrompt to be a string");
    }
    expect(opts.systemPrompt).toContain(xmlPrompt);
    expect(opts.systemPrompt).toContain("load_user_profile");
    expect(opts.systemPrompt).not.toContain("<conversation_context>");

    // Byte-identical output for byte-identical input — the cache contract.
    const opts2 = buildSdkOptions({
      systemPrompt: xmlPrompt,
      cc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });
    expect(opts2.systemPrompt).toBe(opts.systemPrompt);
  });

  // System prompt is always a single string with boot instruction appended.
  // The SDK handles session continuity via persistSession: true, continue: true.
  test("system prompt with custom content preserves it and appends boot instruction", () => {
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
    };
    const composed = `<base/>\n\n<custom_block>content</custom_block>`;
    const opts = buildSdkOptions({
      systemPrompt: composed,
      cc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });
    if (typeof opts.systemPrompt !== "string") {
      throw new Error("expected systemPrompt to be a string");
    }
    expect(opts.systemPrompt).toContain(composed);
    expect(opts.systemPrompt).toContain("load_user_profile");
    expect(opts.systemPrompt).toContain("load_project_rules");
    expect(opts.systemPrompt).toContain("load_session_context");
  });
});
