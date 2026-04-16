import { test, expect, describe } from "bun:test";
import { contextWithoutCurrentTurn } from "./prompt-cc";
import { formatContextForPrompt, buildSdkOptions } from "./formatting";
import { toAnthropicXml } from "../../utils/markdown-to-xml";
import type { CCBackendConfig } from "../../config";

// ── contextWithoutCurrentTurn ──

describe("contextWithoutCurrentTurn", () => {
  test("strips trailing user message when it matches currentQuery", () => {
    const messages = [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "current question" },
    ];
    const result = contextWithoutCurrentTurn(messages, "current question");
    expect(result).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  test("leaves messages unchanged when last message does not match", () => {
    const messages = [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "different question" },
    ];
    const result = contextWithoutCurrentTurn(messages, "current question");
    expect(result).toBe(messages);
  });

  test("leaves messages unchanged when last message is assistant", () => {
    const messages = [
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "answer" },
    ];
    const result = contextWithoutCurrentTurn(messages, "question");
    expect(result).toBe(messages);
  });

  test("handles empty array", () => {
    const result = contextWithoutCurrentTurn([], "anything");
    expect(result).toEqual([]);
  });

  test("preserves context injection pair at the front", () => {
    const messages = [
      {
        role: "user" as const,
        content: "Session context:\n<summaries>\nSummary 1\n</summaries>",
      },
      { role: "assistant" as const, content: "Understood." },
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
      { role: "user" as const, content: "current question" },
    ];
    const result = contextWithoutCurrentTurn(messages, "current question");
    expect(result).toEqual([
      {
        role: "user",
        content: "Session context:\n<summaries>\nSummary 1\n</summaries>",
      },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("handles single user message matching query", () => {
    const messages = [{ role: "user" as const, content: "only message" }];
    const result = contextWithoutCurrentTurn(messages, "only message");
    expect(result).toEqual([]);
  });

  test("only strips the LAST message, not earlier duplicates", () => {
    const messages = [
      { role: "user" as const, content: "repeat" },
      { role: "assistant" as const, content: "response" },
      { role: "user" as const, content: "repeat" },
    ];
    const result = contextWithoutCurrentTurn(messages, "repeat");
    expect(result).toEqual([
      { role: "user", content: "repeat" },
      { role: "assistant", content: "response" },
    ]);
  });

  test("does not strip when query appears only in assistant messages", () => {
    const messages = [
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "the query text" },
    ];
    const result = contextWithoutCurrentTurn(messages, "the query text");
    // Last message is assistant with matching content — should NOT strip
    expect(result).toBe(messages);
  });

  test("returns original array reference when no stripping needed", () => {
    const messages = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ];
    const result = contextWithoutCurrentTurn(messages, "something else");
    expect(result).toBe(messages); // same reference, no copy
  });
});

// ── End-to-end pipeline: server response → SDK options ──
//
// Simulates the full flow: the server's /v1/context/assemble returns a
// systemPrompt + messages array. prompt-cc strips the current user
// message, converts the system prompt to XML, and formats the remaining
// context as structured text in the system prompt for the SDK.

describe("end-to-end: assembled context → claude args + context", () => {
  const serverSystemPrompt =
    "# Critical Rules\nFollow instructions.\n# Identity and Voice\nBe direct.";
  const currentQuery = "What does the auth module do?";

  // Simulate what /v1/context/assemble returns
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

  test("contextWithoutCurrentTurn strips only the current query", () => {
    const context = contextWithoutCurrentTurn(assembledMessages, currentQuery);
    expect(context).toHaveLength(4);
    // Context injection pair preserved
    expect(context[0]!.content).toContain("Session context:");
    expect(context[1]!.content).toBe("Understood.");
    // Prior conversation preserved
    expect(context[2]!.content).toBe("Tell me about the project");
    expect(context[3]!.content).toBe(
      "This is a TypeScript monorepo with two packages.",
    );
  });

  test("formatContextForPrompt produces structured text", () => {
    const context = contextWithoutCurrentTurn(assembledMessages, currentQuery);
    const text = formatContextForPrompt(context);

    expect(text).toContain("<conversation_context>");
    expect(text).toContain("</conversation_context>");
    expect(text).toContain("[User]");
    expect(text).toContain("[Assistant]");
    expect(text).toContain("Session context:");
    expect(text).toContain("Understood.");
    expect(text).toContain("Tell me about the project");
    // Should NOT contain the current query
    expect(text).not.toContain(currentQuery);
  });

  test("formatContextForPrompt returns empty string for no context", () => {
    expect(formatContextForPrompt([])).toBe("");
  });

  test("system prompt is converted to XML with injected blocks", () => {
    const xml = toAnthropicXml(serverSystemPrompt);

    // Structural conversion happened
    expect(xml).toContain("<critical_rules>");
    expect(xml).toContain("</critical_rules>");
    expect(xml).toContain("<identity_and_voice>");

    // CC-specific blocks injected
    expect(xml).toContain("<environment>");
    expect(xml).toContain("<model_override>");

    // Original content preserved
    expect(xml).toContain("Follow instructions.");
    expect(xml).toContain("Be direct.");
  });

  test("buildSdkOptions includes context in system prompt and passes model/disallowedTools", () => {
    const context = contextWithoutCurrentTurn(assembledMessages, currentQuery);
    const xmlPrompt = toAnthropicXml(serverSystemPrompt);
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: ["Agent", "Monitor"],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
    };

    const opts = buildSdkOptions({
      contextMessages: context,
      systemPrompt: xmlPrompt,
      cc,
      model: "opus",
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });

    // Context is concatenated into system prompt
    expect(opts.systemPrompt).toContain(xmlPrompt);
    expect(opts.systemPrompt).toContain("<conversation_context>");

    // Model passed through
    expect(opts.model).toBe("opus");

    // DisallowedTools passed through
    expect(opts.disallowedTools).toEqual(["Agent", "Monitor"]);
  });

  test("first-message scenario: no context keeps system prompt clean", () => {
    const context = contextWithoutCurrentTurn(
      [{ role: "user" as const, content: "hello" }],
      "hello",
    );
    expect(context).toHaveLength(0);

    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
    };
    const opts = buildSdkOptions({
      contextMessages: context,
      systemPrompt: "<system/>",
      cc,
      workingDirectory: "/tmp/test",
      serverUrl: "http://localhost:3777",
      userMemoryDbPath: "/tmp/test-memories.db",
    });

    // No context → system prompt is just the base prompt
    expect(opts.systemPrompt).toBe("<system/>");
    expect(opts.systemPrompt).not.toContain("<conversation_context>");
  });
});
