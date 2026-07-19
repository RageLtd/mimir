import { describe, expect, test } from "bun:test";
import { convertMessage } from "./transcript-persistence";

// convertMessage's param type (OpenCodeMessage) is module-private, but the
// call sites below are structurally checked against it — these fixtures use
// exactly the narrow shape the converter reads.

describe("convertMessage — user turns", () => {
  test("reads user text from text parts (not summary.body)", () => {
    const result = convertMessage({
      info: { id: "u1", sessionID: "s", role: "user" },
      parts: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    });
    expect(result).toEqual({
      role: "user",
      content: "first line\nsecond line",
    });
  });

  test("returns null for a user turn with no text parts", () => {
    // The old code read info.summary.body and persisted every user turn —
    // even empty ones. Now an empty user turn is dropped.
    const result = convertMessage({
      info: { id: "u1", sessionID: "s", role: "user" },
      parts: [{ type: "file" }],
    });
    expect(result).toBeNull();
  });

  test("trims whitespace-only user turns to null", () => {
    const result = convertMessage({
      info: { id: "u1", sessionID: "s", role: "user" },
      parts: [{ type: "text", text: "   \n  " }],
    });
    expect(result).toBeNull();
  });
});

describe("convertMessage — assistant turns", () => {
  test("maps text and tool parts into assistant content", () => {
    const result = convertMessage({
      info: { id: "a1", sessionID: "s", role: "assistant" },
      parts: [
        { type: "text", text: "let me check" },
        {
          type: "tool",
          callID: "call_1",
          name: "read",
          input: { filePath: "/x.ts" },
        },
      ],
    });
    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read",
          input: { filePath: "/x.ts" },
        },
      ],
    });
  });

  test("defaults tool input to {} when absent", () => {
    const result = convertMessage({
      info: { id: "a1", sessionID: "s", role: "assistant" },
      parts: [{ type: "tool", callID: "c", name: "list" }],
    });
    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c", toolName: "list", input: {} },
      ],
    });
  });

  test("skips tool parts missing callID or name", () => {
    const result = convertMessage({
      info: { id: "a1", sessionID: "s", role: "assistant" },
      parts: [
        { type: "text", text: "hi" },
        { type: "tool", name: "read" }, // no callID
      ],
    });
    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });
  });

  test("returns null for an assistant turn with no convertible parts", () => {
    const result = convertMessage({
      info: { id: "a1", sessionID: "s", role: "assistant" },
      parts: [{ type: "reasoning" }, { type: "step-start" }],
    });
    expect(result).toBeNull();
  });
});

describe("convertMessage — other roles", () => {
  test("returns null for the tool role", () => {
    const result = convertMessage({
      info: { id: "t1", sessionID: "s", role: "tool" },
      parts: [{ type: "text", text: "output" }],
    });
    expect(result).toBeNull();
  });
});
