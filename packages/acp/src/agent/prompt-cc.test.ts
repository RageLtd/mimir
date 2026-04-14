import { test, expect, describe } from "bun:test";
import { historyWithoutCurrentTurn } from "./prompt-cc";
import { buildNdjson, iterateNdjson, buildArgs } from "../backends/claude-code";
import { toAnthropicXml } from "../utils/markdown-to-xml";
import type { CCBackendConfig } from "../config";

// ── historyWithoutCurrentTurn ──

describe("historyWithoutCurrentTurn", () => {
  test("strips trailing user message when it matches currentQuery", () => {
    const messages = [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "current question" },
    ];
    const result = historyWithoutCurrentTurn(messages, "current question");
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
    const result = historyWithoutCurrentTurn(messages, "current question");
    expect(result).toBe(messages);
  });

  test("leaves messages unchanged when last message is assistant", () => {
    const messages = [
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "answer" },
    ];
    const result = historyWithoutCurrentTurn(messages, "question");
    expect(result).toBe(messages);
  });

  test("handles empty array", () => {
    const result = historyWithoutCurrentTurn([], "anything");
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
    const result = historyWithoutCurrentTurn(messages, "current question");
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
    const result = historyWithoutCurrentTurn(messages, "only message");
    expect(result).toEqual([]);
  });

  test("only strips the LAST message, not earlier duplicates", () => {
    const messages = [
      { role: "user" as const, content: "repeat" },
      { role: "assistant" as const, content: "response" },
      { role: "user" as const, content: "repeat" },
    ];
    const result = historyWithoutCurrentTurn(messages, "repeat");
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
    const result = historyWithoutCurrentTurn(messages, "the query text");
    // Last message is assistant with matching content — should NOT strip
    expect(result).toBe(messages);
  });

  test("returns original array reference when no stripping needed", () => {
    const messages = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ];
    const result = historyWithoutCurrentTurn(messages, "something else");
    expect(result).toBe(messages); // same reference, no copy
  });
});

// ── End-to-end pipeline: server response → NDJSON + args ──
//
// Simulates the full flow: the server's /v1/context/assemble returns a
// systemPrompt + messages array. prompt-cc splits off the trailing user
// message, converts the system prompt to XML, and passes history as NDJSON.
// These tests verify the final artifacts match the Anthropic/CC spec.

describe("end-to-end: assembled context → claude args + NDJSON", () => {
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

  test("historyWithoutCurrentTurn strips only the current query", () => {
    const history = historyWithoutCurrentTurn(
      assembledMessages,
      currentQuery,
    );
    expect(history).toHaveLength(4);
    // Context injection pair preserved
    expect(history[0]!.content).toContain("Session context:");
    expect(history[1]!.content).toBe("Understood.");
    // Prior conversation preserved
    expect(history[2]!.content).toBe("Tell me about the project");
    expect(history[3]!.content).toBe(
      "This is a TypeScript monorepo with two packages.",
    );
  });

  test("NDJSON from assembled messages has correct turn count and roles", async () => {
    const ndjson = buildNdjson(assembledMessages);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(ndjson));
        c.close();
      },
    });
    const parsed: Array<{ type: string }> = [];
    for await (const obj of iterateNdjson(stream)) {
      parsed.push(obj as { type: string });
    }

    // All 5 messages including the current user query
    expect(parsed).toHaveLength(5);
    expect(parsed.map((p) => p.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  test("context injection pair survives as proper NDJSON messages", async () => {
    const ndjson = buildNdjson(assembledMessages);
    const lines = ndjson.trimEnd().split("\n").map((l) => JSON.parse(l));

    // First line: the "Session context:..." user message
    expect(lines[0].type).toBe("user");
    expect(lines[0].message.role).toBe("user");
    expect(lines[0].message.content[0].text).toContain("<summaries>");
    expect(lines[0].message.content[0].text).toContain("<memories>");

    // Second line: the "Understood." assistant acknowledgment
    expect(lines[1].type).toBe("assistant");
    expect(lines[1].message.role).toBe("assistant");
    expect(lines[1].message.content[0].text).toBe("Understood.");
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

  test("buildArgs produces correct flags for the full pipeline", () => {
    const xmlPrompt = toAnthropicXml(serverSystemPrompt);
    const cc: CCBackendConfig = {
      enabled: true,
      mcpConfigPath: "./mcp.json",
      disallowedTools: ["Agent", "Monitor"],
      permissionMode: "bypassPermissions",
      models: {},
    };

    const args = buildArgs(
      {
        messages: assembledMessages,
        systemPrompt: xmlPrompt,
        cc,
        model: "opus",
      },
      "/tmp/session-mcp.json",
    );

    // -p is empty — messages go via stdin NDJSON
    expect(args[args.indexOf("-p")! + 1]).toBe("");

    // --input-format stream-json always present
    expect(args).toContain("--input-format");

    // --system-prompt carries the XML
    expect(args[args.indexOf("--system-prompt")! + 1]).toBe(xmlPrompt);

    // --model passed through
    expect(args[args.indexOf("--model")! + 1]).toBe("opus");

    // --disallowedTools joined
    expect(args[args.indexOf("--disallowedTools")! + 1]).toBe(
      "Agent,Monitor",
    );
  });

  test("first-message scenario: messages still go via stream-json", () => {
    const firstMessageAssembled = [
      { role: "user" as const, content: "hello" },
    ];

    const cc: CCBackendConfig = {
      enabled: true,
      mcpConfigPath: "./mcp.json",
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: {},
    };
    const args = buildArgs(
      {
        messages: firstMessageAssembled,
        systemPrompt: "<system/>",
        cc,
      },
      "/tmp/mcp.json",
    );

    // Always uses stream-json now
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("-p")! + 1]).toBe("");
  });

  test("each NDJSON line matches SDK SDKUserMessage/SDKAssistantMessage shape", () => {
    const lines = buildNdjson(assembledMessages)
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));

    for (const line of lines) {
      // Required SDK envelope fields
      expect(typeof line.type).toBe("string");
      expect(["user", "assistant"]).toContain(line.type);
      expect(typeof line.session_id).toBe("string");

      // Anthropic API MessageParam shape
      expect(line.message).toBeDefined();
      expect(line.message.role).toBe(line.type);
      expect(Array.isArray(line.message.content)).toBe(true);
      expect(line.message.content.length).toBeGreaterThan(0);

      // Each content block is a text block
      for (const block of line.message.content) {
        expect(block.type).toBe("text");
        expect(typeof block.text).toBe("string");
      }
    }
  });
});
