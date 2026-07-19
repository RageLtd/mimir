import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { sanitizeToolMessages } from "./prompt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantWithToolCalls(...calls: Array<{ id: string; name: string }>) {
  return {
    role: "assistant" as const,
    content: calls.map((c) => ({
      type: "tool-call" as const,
      toolCallId: c.id,
      toolName: c.name,
      input: {},
    })),
  } satisfies ModelMessage;
}

function toolResult(...results: Array<{ id: string; name: string }>) {
  return {
    role: "tool" as const,
    content: results.map((r) => ({
      type: "tool-result" as const,
      toolCallId: r.id,
      toolName: r.name,
      output: { type: "text" as const, value: "ok" },
    })),
  } satisfies ModelMessage;
}

const user = (text: string) =>
  ({ role: "user", content: text }) satisfies ModelMessage;

const assistant = (text: string) =>
  ({ role: "assistant", content: text }) satisfies ModelMessage;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sanitizeToolMessages", () => {
  test("passes through conversation with no tool messages", () => {
    const msgs = [user("hello"), assistant("hi")];
    expect(sanitizeToolMessages(msgs)).toEqual(msgs);
  });

  test("keeps valid tool results with matching assistant tool_calls", () => {
    const msgs = [
      user("do something"),
      assistantWithToolCalls({ id: "tc1", name: "search" }),
      toolResult({ id: "tc1", name: "search" }),
      assistant("done"),
    ];
    expect(sanitizeToolMessages(msgs)).toEqual(msgs);
  });

  test("drops leading orphan tool results (window-boundary cut)", () => {
    const msgs = [
      toolResult({ id: "tc-gone", name: "search" }),
      user("next question"),
      assistant("answer"),
    ];
    const result = sanitizeToolMessages(msgs);
    expect(result).toEqual([user("next question"), assistant("answer")]);
  });

  test("drops interior orphan tool results", () => {
    const msgs = [
      user("first"),
      assistant("reply"),
      toolResult({ id: "tc-missing", name: "read" }),
      user("second"),
      assistant("reply2"),
    ];
    const result = sanitizeToolMessages(msgs);
    expect(result).toEqual([
      user("first"),
      assistant("reply"),
      user("second"),
      assistant("reply2"),
    ]);
  });

  test("drops orphan but keeps valid tool result in same conversation", () => {
    const msgs = [
      toolResult({ id: "tc-orphan", name: "gone" }),
      user("question"),
      assistantWithToolCalls({ id: "tc1", name: "search" }),
      toolResult({ id: "tc1", name: "search" }),
      assistant("done"),
    ];
    const result = sanitizeToolMessages(msgs);
    expect(result).toEqual([
      user("question"),
      assistantWithToolCalls({ id: "tc1", name: "search" }),
      toolResult({ id: "tc1", name: "search" }),
      assistant("done"),
    ]);
  });

  test("handles multiple tool calls in one assistant message", () => {
    const msgs = [
      assistantWithToolCalls(
        { id: "tc1", name: "search" },
        { id: "tc2", name: "read" },
      ),
      toolResult({ id: "tc1", name: "search" }, { id: "tc2", name: "read" }),
    ];
    expect(sanitizeToolMessages(msgs)).toEqual(msgs);
  });

  test("coalesces split tool result messages for one assistant tool-call turn", () => {
    const assistantTurn = assistantWithToolCalls(
      { id: "tc1", name: "search" },
      { id: "tc2", name: "read" },
    );
    const msgs = [
      assistantTurn,
      toolResult({ id: "tc1", name: "search" }),
      toolResult({ id: "tc2", name: "read" }),
      assistant("done"),
    ];
    const result = sanitizeToolMessages(msgs);
    expect(result).toEqual([
      assistantTurn,
      toolResult({ id: "tc1", name: "search" }, { id: "tc2", name: "read" }),
      assistant("done"),
    ]);
  });

  test("orders coalesced tool results to match the assistant call order", () => {
    const assistantTurn = assistantWithToolCalls(
      { id: "tc1", name: "search" },
      { id: "tc2", name: "read" },
    );
    const result = sanitizeToolMessages([
      assistantTurn,
      toolResult({ id: "tc2", name: "read" }),
      toolResult({ id: "tc1", name: "search" }),
    ]);
    expect(result).toEqual([
      assistantTurn,
      toolResult({ id: "tc1", name: "search" }, { id: "tc2", name: "read" }),
    ]);
  });

  test("drops assistant tool-call turn when the matching results are incomplete", () => {
    const msgs = [
      user("do two things"),
      assistantWithToolCalls(
        { id: "tc1", name: "search" },
        { id: "tc2", name: "read" },
      ),
      toolResult({ id: "tc1", name: "search" }),
      user("next question"),
    ];
    const result = sanitizeToolMessages(msgs);
    expect(result).toEqual([user("do two things"), user("next question")]);
  });

  test("drops tool message when only some results have matching calls", () => {
    const msgs = [
      assistantWithToolCalls({ id: "tc1", name: "search" }),
      toolResult(
        { id: "tc1", name: "search" },
        { id: "tc-missing", name: "gone" },
      ),
    ];
    const result = sanitizeToolMessages(msgs);
    // The whole tool message is dropped because tc-missing has no match
    expect(result).toEqual([]);
  });

  test("handles empty input", () => {
    expect(sanitizeToolMessages([])).toEqual([]);
  });

  test("drops tool messages with non-array content", () => {
    const oddTool = { role: "tool" as const, content: "raw string" };
    const msgs = [user("hi"), oddTool as unknown as ModelMessage];
    expect(sanitizeToolMessages(msgs)).toEqual([user("hi")]);
  });
});
