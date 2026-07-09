/**
 * streamTurn contract tests — the single-doStream turn engine (MIM-89).
 *
 * A fake LanguageModelV3 doStream yields scripted parts; assertions pin
 * the event translation: deltas stream through in order, tool calls
 * flush after the read loop with parsed-object inputs, finish carries
 * usage, and in-stream error parts throw (the caller drives the iterator
 * with .next().catch() per the ACP pattern).
 */

import { describe, expect, test } from "bun:test";
import { streamTurn, type TurnEvent } from "./stream";

type Part = Record<string, unknown>;

const fakeModel = (parts: Part[]) => ({
  doStream: async () => ({
    stream: new ReadableStream<Part>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  }),
});

const collect = async (parts: Part[]) => {
  const events: TurnEvent[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: fake model narrows the Pick<LanguageModelV3> contract
  for await (const event of streamTurn({
    model: fakeModel(parts) as any,
    prompt: [],
  })) {
    events.push(event);
  }
  return events;
};

const finishPart = (input: number, output: number) => ({
  type: "finish",
  finishReason: { unified: "stop" },
  usage: {
    inputTokens: { total: input },
    outputTokens: { total: output },
  },
});

describe("streamTurn", () => {
  test("streams text and thinking deltas in order, finish carries usage", async () => {
    const events = await collect([
      { type: "reasoning-delta", delta: "hmm " },
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " world" },
      finishPart(120, 8),
    ]);

    expect(events).toEqual([
      { type: "thinking", text: "hmm " },
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "finish", reason: "stop", inputTokens: 120, outputTokens: 8 },
    ]);
  });

  test("tool calls flush after the stream with parsed-object input", async () => {
    const events = await collect([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read_file",
        input: '{"path":"/tmp/x"}',
      },
      { type: "text-delta", delta: "reading" },
      {
        ...finishPart(50, 5),
        finishReason: { unified: "tool-calls" },
      },
    ]);

    // Text delta first (streamed live), tool call flushed at stream end.
    expect(events[0]).toEqual({ type: "text", text: "reading" });
    expect(events[1]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "read_file",
      input: { path: "/tmp/x" },
    });
    expect(events[2]).toEqual({
      type: "finish",
      reason: "tool-calls",
      inputTokens: 50,
      outputTokens: 5,
    });
  });

  test("malformed tool-call arguments collapse to an empty object", async () => {
    const events = await collect([
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "grep",
        input: "not json {{",
      },
      finishPart(10, 1),
    ]);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "call_2",
      name: "grep",
      input: {},
    });
  });

  test("in-stream error part throws to the caller", async () => {
    const iterate = async () => {
      await collect([
        { type: "text-delta", delta: "partial" },
        { type: "error", error: new Error("upstream 500") },
      ]);
    };
    expect(iterate()).rejects.toThrow("upstream 500");
  });

  test("unknown part types are ignored", async () => {
    const events = await collect([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", delta: "ok" },
      { type: "text-end", id: "t1" },
      finishPart(5, 1),
    ]);

    expect(events).toEqual([
      { type: "text", text: "ok" },
      { type: "finish", reason: "stop", inputTokens: 5, outputTokens: 1 },
    ]);
  });
});
