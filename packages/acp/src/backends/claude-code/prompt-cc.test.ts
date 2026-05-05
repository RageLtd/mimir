import { describe, expect, test } from "bun:test";
import type { CCBackendConfig } from "../../config";
import { toAnthropicXml } from "../../utils/markdown-to-xml";
import { buildSdkOptions, formatContextForPrompt } from "./formatting";

// ── End-to-end pipeline: server response → SDK options ──
//
// Simulates the full flow: the server's /v1/context/assemble returns a
// systemPrompt + messages array. prompt-cc strips the current user
// message, converts the system prompt to XML, and the assembled context
// is injected directly into the system prompt as boot content. The
// system prompt is passed verbatim to buildSdkOptions.

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

  test("buildSdkOptions passes system prompt through and sets model/disallowedTools", () => {
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

    expect(opts.systemPrompt).toBe(xmlPrompt);
    expect(opts.model).toBe("opus");
    expect(opts.disallowedTools).toEqual(["Agent", "Monitor"]);
  });

  test("buildSdkOptions passes system prompt verbatim without modification", () => {
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

    expect(opts.systemPrompt).toBe("<system/>");
  });

  test("buildSdkOptions produces byte-identical output for identical input (cache contract)", () => {
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

    const opts2 = buildSdkOptions({
      systemPrompt: xmlPrompt,
      cc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });
    expect(opts2.systemPrompt).toBe(opts.systemPrompt);
  });
});
