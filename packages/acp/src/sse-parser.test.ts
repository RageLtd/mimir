import { test, expect, describe } from "bun:test";
import { parseSSELine, chunkToEvents, iterateSSE } from "./sse-parser";
import type { ChatCompletionChunk, SSEEvent } from "./sse-parser";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal ChatCompletionChunk factory. */
const chunk = (overrides: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "test-model",
  choices: [],
  ...overrides,
});

/** Single-choice chunk with a delta. */
const choiceChunk = (
  delta: Record<string, unknown>,
  overrides: Partial<ChatCompletionChunk> = {},
): ChatCompletionChunk =>
  chunk({
    choices: [{ index: 0, delta: delta as ChatCompletionChunk["choices"][number]["delta"], finish_reason: null }],
    ...overrides,
  });

/** Wrap a chunk as an SSE data line. */
const sseLine = (data: Record<string, unknown>) =>
  `data: ${JSON.stringify(data)}`;

// ── parseSSELine ──────────────────────────────────────────────────────────────

describe("parseSSELine", () => {
  test("parses valid SSE data line", () => {
    const line = sseLine({ id: "abc", object: "chat.completion.chunk", created: 1, model: "m", choices: [] });
    const result = parseSSELine(line);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc");
  });

  test("returns null for non-data lines", () => {
    expect(parseSSELine(": comment")).toBeNull();
    expect(parseSSELine("id: 123")).toBeNull();
    expect(parseSSELine("")).toBeNull();
  });

  test("returns null for [DONE] sentinel", () => {
    expect(parseSSELine("data: [DONE]")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseSSELine("data: {broken")).toBeNull();
  });
});

// ── chunkToEvents: existing event types ────────────────────────────────────────

describe("chunkToEvents", () => {
  test("emits content event from delta", () => {
    const events = chunkToEvents(choiceChunk({ content: "hello" }));
    expect(events).toEqual([{ type: "content", text: "hello" }]);
  });

  test("emits thinking event from reasoning_content", () => {
    const events = chunkToEvents(choiceChunk({ reasoning_content: "pondering" }));
    expect(events).toEqual([{ type: "thinking", text: "pondering" }]);
  });

  test("emits tool_call_delta events", () => {
    const delta = { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] };
    const events = chunkToEvents(choiceChunk(delta));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool_call_delta");
  });

  test("emits finish event from finish_reason", () => {
    const events = chunkToEvents(
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    );
    expect(events).toEqual([{ type: "finish", reason: "stop" }]);
  });

  test("emits usage event from top-level usage", () => {
    const events = chunkToEvents(
      chunk({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
    );
    expect(events).toEqual([{
      type: "usage",
      promptTokens: 100,
      completionTokens: 50,
      contextWindow: undefined,
    }]);
  });
});

// ── chunkToEvents: tool_observation (mimir extension) ─────────────────────────

describe("chunkToEvents: tool_observation", () => {
  test("emits tool_observation from mimir_tool_observation delta", () => {
    const events = chunkToEvents(choiceChunk({
      content: "",
      mimir_tool_observation: {
        id: "obs_1",
        name: "read_project_memory",
        input: { query: "test" },
        result: "found something",
      },
    }));

    const obs = events.find((e) => e.type === "tool_observation");
    expect(obs).toBeDefined();
    expect(obs).toEqual({
      type: "tool_observation",
      id: "obs_1",
      name: "read_project_memory",
      input: { query: "test" },
      result: "found something",
    });
  });

  test("coerces non-string result to string", () => {
    const events = chunkToEvents(choiceChunk({
      content: "",
      mimir_tool_observation: {
        id: "obs_2",
        name: "search",
        input: {},
        result: 42,
      },
    }));

    const obs = events.find((e) => e.type === "tool_observation");
    expect(obs).toBeDefined();
    if (obs && obs.type === "tool_observation") {
      expect(obs.result).toBe("42");
    }
  });

  test("defaults missing result to empty string", () => {
    const events = chunkToEvents(choiceChunk({
      content: "",
      mimir_tool_observation: {
        id: "obs_3",
        name: "search",
        input: {},
      },
    }));

    const obs = events.find((e) => e.type === "tool_observation");
    expect(obs).toBeDefined();
    if (obs && obs.type === "tool_observation") {
      expect(obs.result).toBe("");
    }
  });

  test("defaults missing input to empty object", () => {
    const events = chunkToEvents(choiceChunk({
      content: "",
      mimir_tool_observation: {
        id: "obs_4",
        name: "search",
        result: "ok",
      },
    }));

    const obs = events.find((e) => e.type === "tool_observation");
    expect(obs).toBeDefined();
    if (obs && obs.type === "tool_observation") {
      expect(obs.input).toEqual({});
    }
  });

  test("skips tool_observation when id is not a string", () => {
    const events = chunkToEvents(choiceChunk({
      content: "",
      mimir_tool_observation: {
        id: 123,
        name: "search",
        input: {},
        result: "ok",
      },
    }));

    expect(events.some((e) => e.type === "tool_observation")).toBe(false);
  });

  test("skips tool_observation when payload is null", () => {
    const events = chunkToEvents(choiceChunk({
      content: "",
      mimir_tool_observation: null,
    }));

    expect(events.some((e) => e.type === "tool_observation")).toBe(false);
  });

  test("emits tool_observation alongside content and usage events", () => {
    const events = chunkToEvents(choiceChunk({
      content: "text",
      mimir_tool_observation: {
        id: "obs_5",
        name: "tool",
        input: {},
        result: "result",
      },
    }, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    expect(events.some((e) => e.type === "content")).toBe(true);
    expect(events.some((e) => e.type === "tool_observation")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});

// ── iterateSSE ────────────────────────────────────────────────────────────────

describe("iterateSSE", () => {
  test("yields tool_observation events from a stream", async () => {
    const observationChunk = choiceChunk({
      mimir_tool_observation: {
        id: "obs_stream",
        name: "web_search",
        input: { query: "mimir" },
        result: "Norse god of wisdom",
      },
    });
    const lines = [
      sseLine(observationChunk),
      "data: [DONE]",
    ].join("\n");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines));
        controller.close();
      },
    });

    const events: SSEEvent[] = [];
    for await (const event of iterateSSE(stream)) {
      events.push(event);
    }

    const obs = events.find((e) => e.type === "tool_observation");
    expect(obs).toBeDefined();
    if (obs && obs.type === "tool_observation") {
      expect(obs.id).toBe("obs_stream");
      expect(obs.name).toBe("web_search");
      expect(obs.input).toEqual({ query: "mimir" });
      expect(obs.result).toBe("Norse god of wisdom");
    }
  });

  test("yields content, finish, and usage from a standard stream", async () => {
    const contentChunk = choiceChunk({ content: "Hello" });
    const finishChunk = chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    const usageChunk = chunk({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    const lines = [
      sseLine(contentChunk),
      sseLine(finishChunk),
      sseLine(usageChunk),
      "data: [DONE]",
    ].join("\n");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines));
        controller.close();
      },
    });

    const events: SSEEvent[] = [];
    for await (const event of iterateSSE(stream)) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("content");
    expect(types).toContain("finish");
    expect(types).toContain("usage");
  });

  test("handles split chunks across reads", async () => {
    // Simulate a tool observation arriving in two separate reads
    const observationChunk = choiceChunk({
      mimir_tool_observation: {
        id: "obs_split",
        name: "read_file",
        input: { path: "/test" },
        result: "contents",
      },
    });
    const fullLine = sseLine(observationChunk) + "\ndata: [DONE]\n";
    const half = Math.ceil(fullLine.length / 2);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(fullLine.slice(0, half)));
        controller.enqueue(new TextEncoder().encode(fullLine.slice(half)));
        controller.close();
      },
    });

    const events: SSEEvent[] = [];
    for await (const event of iterateSSE(stream)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "tool_observation")).toBe(true);
  });
});
