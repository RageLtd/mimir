/**
 * Tests for the conversation conversion: Messages-API form, as the hooks
 * module hands it, → ModelMessage[] for the brain.
 */

import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import type { CompletionRequest } from "@mimir/plugin-core/brain/extract";
import {
  type ApiMessage,
  answer,
  type Completions,
  completionText,
  toModelMessages,
} from "./conversation";

describe("answer", () => {
  let written: string[] = [];
  let write: Mock<typeof process.stdout.write> | undefined;
  const spy = () => {
    write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  };

  afterEach(() => {
    write?.mockRestore();
    write = undefined;
    written = [];
  });

  test("writes only { advance } when no requests are given", () => {
    spy();
    answer(true);
    expect(written.map((chunk) => JSON.parse(chunk))).toEqual([
      { advance: true },
    ]);
  });

  test("writes { advance, requests } when requests are given", () => {
    const facts: CompletionRequest = {
      system: "sys",
      prompt: "user: hi",
      maxTokens: 2048,
    };
    spy();
    answer(false, { facts });
    expect(written.map((chunk) => JSON.parse(chunk))).toEqual([
      { advance: false, requests: { facts } },
    ]);
  });
});

/**
 * Completions as readDistillInput hands them over: whatever JSON the hooks
 * module wrote on stdin, typed but unvalidated.
 */
const fromStdin = (raw: unknown) =>
  // Serialisation boundary: the shape is what the wire carried, not what the type claims.
  JSON.parse(JSON.stringify(raw)) as Completions;

describe("completionText", () => {
  test("a text completion is ok with its text", () => {
    expect(
      completionText(fromStdin({ facts: { text: "x" } }), "facts"),
    ).toEqual({ ok: true, text: "x" });
  });

  test("an error completion is not ok and names the error", () => {
    expect(
      completionText(fromStdin({ facts: { error: "api-error" } }), "facts"),
    ).toEqual({ ok: false, reason: expect.stringContaining("api-error") });
  });

  test("a missing key is not ok", () => {
    expect(
      completionText(fromStdin({ summary: { text: "x" } }), "facts"),
    ).toEqual({ ok: false, reason: expect.any(String) });
  });

  test("no completions at all is not ok", () => {
    expect(completionText(undefined, "facts")).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });

  const MALFORMED: readonly [string, unknown][] = [
    ["a string", { facts: "a string" }],
    ["null", { facts: null }],
    ["a null text", { facts: { text: null } }],
    ["a numeric text", { facts: { text: 42 } }],
    ["an empty object", { facts: {} }],
  ];

  for (const [label, raw] of MALFORMED) {
    test(`a malformed completion (${label}) is not ok, with a reason, and does not throw`, () => {
      const result = completionText(fromStdin(raw), "facts");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }
});

const user = (text: string): ApiMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("toModelMessages", () => {
  test("converts a user message's text", () => {
    expect(toModelMessages([user("What does foo do?")])).toEqual([
      { role: "user", content: "What does foo do?" },
    ]);
  });

  test("drops slash-command scaffolding and empty messages", () => {
    expect(
      toModelMessages([
        user("<local-command-stdout>noise</local-command-stdout>"),
        user("<command-name>/slash</command-name>"),
        { role: "user", content: [] },
        { role: "assistant", content: [{ type: "thinking", thinking: "…" }] },
      ]),
    ).toEqual([]);
  });

  test("drops engine-injected system reminders, keeping what the developer typed", () => {
    const reminder = `<system-reminder>\nprompt.submit hook additional context: ${"x".repeat(8000)}\n</system-reminder>`;
    expect(
      toModelMessages([
        {
          role: "user",
          content: [
            { type: "text", text: reminder },
            { type: "text", text: "Lets merge the branch into cc-mod" },
          ],
        },
        // A tool result's user message carrying nothing but a reminder.
        user(reminder),
      ]),
    ).toEqual([{ role: "user", content: "Lets merge the branch into cc-mod" }]);
  });

  test("keeps an assistant message's text and tool calls, thinking stripped", () => {
    const [message] = toModelMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deliberating..." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "ls" },
          },
          { type: "text", text: "Here is the listing." },
        ],
      },
    ]);
    expect(message).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu_1",
          toolName: "Bash",
          input: { command: "ls" },
        },
        { type: "text", text: "Here is the listing." },
      ],
    });
  });

  test("converts tool results to a role:tool message named from the delta's tool calls", () => {
    const messages = toModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_42",
            name: "Read",
            input: { file_path: "/x.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_42",
            content: [{ type: "text", text: "file contents here" }],
            is_error: false,
          },
          { type: "text", text: "and a follow-up" },
        ],
      },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu_42",
          toolName: "Read",
          output: { type: "text", value: "file contents here" },
        },
      ],
    });
    expect(messages[2]).toEqual({ role: "user", content: "and a follow-up" });
  });

  test("a result whose call fell before the delta is kept under an unknown name", () => {
    const [message] = toModelMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_old", content: "earlier" },
        ],
      },
    ]);
    expect(message).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu_old",
          toolName: "unknown",
          output: { type: "text", value: "earlier" },
        },
      ],
    });
  });
});
