/**
 * Tests for the conversation conversion: Messages-API form, as the hooks
 * module hands it, → ModelMessage[] for the brain.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CompletionRequest } from "@mimir/plugin-core/brain/extract";
import {
  type ApiMessage,
  answer,
  type DistillInput,
  toModelMessages,
} from "./conversation";

describe("answer", () => {
  let written: string[] = [];
  const spy = () =>
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

  afterEach(() => {
    written = [];
  });

  test("writes only { advance } when no requests are given", () => {
    const write = spy();
    answer(true);
    write.mockRestore();
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
    const write = spy();
    answer(false, { facts });
    write.mockRestore();
    expect(written.map((chunk) => JSON.parse(chunk))).toEqual([
      { advance: false, requests: { facts } },
    ]);
  });
});

describe("DistillInput", () => {
  test("a phase-two payload carries completions keyed by request, text or error", () => {
    // Serialisation boundary, as readDistillInput parses it.
    const input = JSON.parse(
      JSON.stringify({
        session_id: "s1",
        messages: [],
        completions: {
          facts: { text: '["a"]' },
          summary: { error: "api-error" },
        },
      }),
    ) as DistillInput;
    const completions: DistillInput["completions"] = input.completions;
    expect(completions).toEqual({
      facts: { text: '["a"]' },
      summary: { error: "api-error" },
    });
  });
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
