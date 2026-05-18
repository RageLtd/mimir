import { describe, expect, test } from "bun:test";
import {
  createCodexAppServerEventTranslator,
  type CodexAppServerNotification,
} from "./app-server-events";

const THREAD_ID = "thread_1";
const TURN_ID = "turn_1";
const NOW = Date.now();

const delta = (
  method: CodexAppServerNotification["method"],
  itemId: string,
  deltaText: string,
) =>
  ({
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId, delta: deltaText },
  }) as CodexAppServerNotification;

const started = (item: Record<string, unknown>) =>
  ({
    method: "item/started",
    params: { item, threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: NOW },
  }) as CodexAppServerNotification;

const completed = (item: Record<string, unknown>) =>
  ({
    method: "item/completed",
    params: {
      item,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: NOW,
    },
  }) as CodexAppServerNotification;

describe("Codex app-server event translation", () => {
  test("streams agent message deltas directly", () => {
    const translate = createCodexAppServerEventTranslator();
    const events = [
      delta("item/agentMessage/delta", "msg_1", "Hello"),
      delta("item/agentMessage/delta", "msg_1", " world"),
      completed({ id: "msg_1", type: "agentMessage", text: "Hello world" }),
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ]);
  });

  test("emits completed agent text when no delta arrived", () => {
    const translate = createCodexAppServerEventTranslator();
    const event = completed({
      id: "msg_1",
      type: "agentMessage",
      text: "Done.",
    });

    expect([...translate(event)]).toEqual([{ type: "text", text: "Done." }]);
  });

  test("streams reasoning deltas as thought chunks", () => {
    const translate = createCodexAppServerEventTranslator();
    const events = [
      delta("item/reasoning/textDelta", "reason_1", "Checking"),
      delta("item/reasoning/textDelta", "reason_1", " files"),
      completed({
        id: "reason_1",
        type: "reasoning",
        content: ["Checking files"],
        summary: [],
      }),
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      { type: "thinking", text: "Checking" },
      { type: "thinking", text: " files" },
    ]);
  });

  test("streams command output deltas and completes with accumulated output", () => {
    const translate = createCodexAppServerEventTranslator();
    const events = [
      started({
        id: "cmd_1",
        type: "commandExecution",
        command: ["bun", "test"],
      }),
      delta("item/commandExecution/outputDelta", "cmd_1", "running"),
      delta("item/commandExecution/outputDelta", "cmd_1", " tests\nok"),
      completed({ id: "cmd_1", type: "commandExecution" }),
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      {
        type: "tool_call",
        id: "cmd_1",
        name: "terminal",
        input: { command: "bun test" },
        observeOnly: true,
      },
      {
        type: "tool_update",
        id: "cmd_1",
        output: "running",
        observeOnly: true,
      },
      {
        type: "tool_update",
        id: "cmd_1",
        output: " tests\nok",
        observeOnly: true,
      },
      {
        type: "tool_result",
        id: "cmd_1",
        output: "running tests\nok",
        observeOnly: true,
      },
    ]);
  });

  test("maps app-server turn boundaries", () => {
    const translate = createCodexAppServerEventTranslator();
    const events: CodexAppServerNotification[] = [
      {
        method: "thread/started",
        params: { thread: { id: "thread_1" } },
      },
      {
        method: "turn/completed",
        params: {
          threadId: THREAD_ID,
          turn: { id: "turn_1", error: null },
        },
      },
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      { type: "init", sessionId: "thread_1", tools: [] },
      {
        type: "finish",
        promptTokens: 0,
        completionTokens: 0,
        contextWindow: undefined,
      },
    ]);
  });

  test("surfaces error notifications with actual message", () => {
    const translate = createCodexAppServerEventTranslator();
    const event: CodexAppServerNotification = {
      method: "error",
      params: {
        error: { message: "rate limit exceeded" },
        willRetry: false,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    };

    const output = [...translate(event)];

    expect(output).toEqual([
      { type: "error", error: "rate limit exceeded" },
      {
        type: "finish",
        stopReason: "failed",
        errors: ["rate limit exceeded"],
      },
    ]);
  });

  test("error with willRetry does not emit finish", () => {
    const translate = createCodexAppServerEventTranslator();
    const event: CodexAppServerNotification = {
      method: "error",
      params: {
        error: { message: "temporary failure" },
        willRetry: true,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    };

    const output = [...translate(event)];

    expect(output).toEqual([
      { type: "error", error: "temporary failure" },
    ]);
  });

  test("tracks token usage from thread/tokenUsage/updated", () => {
    const translate = createCodexAppServerEventTranslator();
    const events: CodexAppServerNotification[] = [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          tokenUsage: {
            total: { input: 1500, output: 300 },
            last: { input: 500, output: 100 },
            modelContextWindow: 128000,
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: THREAD_ID,
          turn: { id: TURN_ID, error: null },
        },
      },
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      {
        type: "finish",
        promptTokens: 1500,
        completionTokens: 300,
        contextWindow: 128000,
      },
    ]);
  });

  test("observes MCP tool calls and results", () => {
    const translate = createCodexAppServerEventTranslator();
    const events = [
      started({
        id: "mcp_1",
        type: "mcpToolCall",
        server: "filesystem",
        tool: "read_text_file",
        arguments: { path: "README.md" },
      }),
      completed({
        id: "mcp_1",
        type: "mcpToolCall",
        server: "filesystem",
        tool: "read_text_file",
        arguments: { path: "README.md" },
        result: {
          content: [{ type: "text", text: "Hello" }],
          structuredContent: { ok: true },
        },
        error: null,
      }),
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      {
        type: "tool_call",
        id: "mcp_1",
        name: "filesystem.read_text_file",
        input: {
          server: "filesystem",
          tool: "read_text_file",
          arguments: { path: "README.md" },
        },
        observeOnly: true,
      },
      {
        type: "tool_result",
        id: "mcp_1",
        output:
          '{"content":[{"type":"text","text":"Hello"}],"structuredContent":{"ok":true}}',
        observeOnly: true,
      },
    ]);
  });

  test("observes file change calls and results", () => {
    const translate = createCodexAppServerEventTranslator();
    const events = [
      started({
        id: "file_1",
        type: "fileChange",
        changes: [{ kind: "update", path: "src/index.ts", diff: "@@" }],
      }),
      completed({
        id: "file_1",
        type: "fileChange",
        changes: [{ kind: "update", path: "src/index.ts", diff: "@@" }],
      }),
    ];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      {
        type: "tool_call",
        id: "file_1",
        name: "codex_file_change",
        input: {
          changes: [{ kind: "update", path: "src/index.ts", diff: "@@" }],
        },
        observeOnly: true,
      },
      {
        type: "tool_result",
        id: "file_1",
        output: "update src/index.ts",
        observeOnly: true,
      },
    ]);
  });

  test("skips passthrough item types without error", () => {
    const translate = createCodexAppServerEventTranslator();
    const event = completed({
      id: "ctx_1",
      type: "contextCompaction",
    });

    const output = [...translate(event)];
    expect(output).toEqual([]);
  });

  test("streams file change output deltas", () => {
    const translate = createCodexAppServerEventTranslator();
    const event = delta("item/fileChange/outputDelta", "file_1", "applying");
    const output = [...translate(event)];

    expect(output).toEqual([
      {
        type: "tool_update",
        id: "file_1",
        output: "applying",
        observeOnly: true,
      },
    ]);
  });

  test("streams plan deltas as text", () => {
    const translate = createCodexAppServerEventTranslator();
    const event = delta("item/plan/delta", "plan_1", "Step 1: read files");
    const output = [...translate(event)];

    expect(output).toEqual([
      { type: "text", text: "Step 1: read files" },
    ]);
  });
});
