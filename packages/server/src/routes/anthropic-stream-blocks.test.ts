/**
 * Tests for thinking and tool_use content blocks in the Anthropic
 * stream state machine. Lives separate from `anthropic-stream.test.ts`
 * (which covers text + state lifecycle) to keep both files under the
 * 500-line cap.
 */

import { describe, expect, test } from "bun:test";
import {
  type AnthropicStreamState,
  initialAnthropicStreamState,
  processFinish,
  processReasoningDelta,
  processTextDelta,
  processToolCalls,
  processUsage,
} from "./anthropic-stream";

const MESSAGE_ID = "msg_test456";
const MODEL_ID = "glm-5.1";

describe("processReasoningDelta", () => {
  test("first reasoning delta emits message_start + content_block_start (thinking) + content_block_delta (thinking_delta)", () => {
    const result = processReasoningDelta(
      initialAnthropicStreamState(),
      "Let me think...",
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(result.events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ]);

    const [, blockStart, blockDelta] = result.events;
    expect(blockStart?.data).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    expect(blockDelta?.data).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me think..." },
    });
    expect(result.state.currentBlockType).toBe("thinking");
  });

  test("second reasoning delta into open thinking block only emits content_block_delta", () => {
    const first = processReasoningDelta(
      initialAnthropicStreamState(),
      "first",
      MODEL_ID,
      MESSAGE_ID,
    );
    const second = processReasoningDelta(
      first.state,
      " more",
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(second.events.map((e) => e.event)).toEqual(["content_block_delta"]);
    expect(second.events[0]?.data).toMatchObject({
      delta: { type: "thinking_delta", thinking: " more" },
    });
  });

  test("transition from text → thinking closes the text block first", () => {
    const text = processTextDelta(
      initialAnthropicStreamState(),
      "Hi.",
      MODEL_ID,
      MESSAGE_ID,
    );
    const thinking = processReasoningDelta(
      text.state,
      "Now reasoning.",
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(thinking.events.map((e) => e.event)).toEqual([
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
    ]);
    expect(thinking.events[0]?.data).toMatchObject({
      type: "content_block_stop",
      index: 0,
    });
    expect(thinking.events[1]?.data).toMatchObject({
      content_block: { type: "thinking", thinking: "" },
      index: 1,
    });
    expect(thinking.state.currentBlockIndex).toBe(1);
    expect(thinking.state.currentBlockType).toBe("thinking");
  });

  test("transition from thinking → text closes the thinking block first", () => {
    const thinking = processReasoningDelta(
      initialAnthropicStreamState(),
      "Reasoning.",
      MODEL_ID,
      MESSAGE_ID,
    );
    const text = processTextDelta(
      thinking.state,
      "Now speaking.",
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(text.events.map((e) => e.event)).toEqual([
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
    ]);
    expect(text.events[1]?.data).toMatchObject({
      content_block: { type: "text", text: "" },
      index: 1,
    });
    expect(text.state.currentBlockIndex).toBe(1);
    expect(text.state.currentBlockType).toBe("text");
  });
});

describe("processToolCalls", () => {
  test("single tool call from initial state emits message_start + start + delta + stop", () => {
    const result = processToolCalls(
      initialAnthropicStreamState(),
      [
        {
          id: "toolu_1",
          name: "get_weather",
          arguments: '{"city":"Vancouver"}',
        },
      ],
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(result.events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);

    expect(result.events[1]?.data).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "get_weather",
        input: {},
      },
    });
    expect(result.events[2]?.data).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"city":"Vancouver"}',
      },
    });
    expect(result.events[3]?.data).toMatchObject({
      type: "content_block_stop",
      index: 0,
    });

    // After a tool_use block, currentBlockType returns to null so the
    // next tool call (or text/thinking) opens at a new index.
    expect(result.state.currentBlockType).toBe(null);
    expect(result.state.currentBlockIndex).toBe(0);
  });

  test("multiple tool calls produce sequential blocks at incrementing indices", () => {
    const result = processToolCalls(
      initialAnthropicStreamState(),
      [
        { id: "toolu_1", name: "first", arguments: "{}" },
        { id: "toolu_2", name: "second", arguments: '{"x":1}' },
      ],
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(result.events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);

    expect(result.events[1]?.data).toMatchObject({ index: 0 });
    expect(result.events[4]?.data).toMatchObject({ index: 1 });
    expect(result.state.currentBlockIndex).toBe(1);
  });

  test("tool call after open text block closes the text block first", () => {
    const text = processTextDelta(
      initialAnthropicStreamState(),
      "Let me check.",
      MODEL_ID,
      MESSAGE_ID,
    );
    const tools = processToolCalls(
      text.state,
      [{ id: "toolu_1", name: "get_weather", arguments: "{}" }],
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(tools.events.map((e) => e.event)).toEqual([
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);
    expect(tools.events[0]?.data).toMatchObject({ index: 0 });
    expect(tools.events[1]?.data).toMatchObject({ index: 1 });
  });

  test("tool call after open thinking block closes the thinking block first", () => {
    const thinking = processReasoningDelta(
      initialAnthropicStreamState(),
      "Thinking.",
      MODEL_ID,
      MESSAGE_ID,
    );
    const tools = processToolCalls(
      thinking.state,
      [{ id: "toolu_1", name: "get_weather", arguments: "{}" }],
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(tools.events[0]?.data).toMatchObject({
      type: "content_block_stop",
      index: 0,
    });
    expect(tools.events[1]?.data).toMatchObject({
      content_block: { type: "tool_use" },
      index: 1,
    });
  });
});

describe("closing open thinking block at processUsage", () => {
  test("closes thinking block before terminal message_delta + message_stop", () => {
    const afterThinking = processReasoningDelta(
      initialAnthropicStreamState(),
      "Reasoning.",
      MODEL_ID,
      MESSAGE_ID,
    );
    const afterFinish = processFinish(afterThinking.state, "stop");

    const result = processUsage(afterFinish.state, {
      prompt_tokens: 50,
      completion_tokens: 5,
      total_tokens: 55,
    });

    expect(result.events.map((e) => e.event)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("mixed-block full sequence", () => {
  test("reasoning then text then tool_use produces correct event order", () => {
    const events: string[] = [];
    let state: AnthropicStreamState = initialAnthropicStreamState();

    let r = processReasoningDelta(state, "Thinking...", MODEL_ID, MESSAGE_ID);
    state = r.state;
    events.push(...r.events.map((e) => e.event));

    const r2 = processTextDelta(
      state,
      "Let me look this up.",
      MODEL_ID,
      MESSAGE_ID,
    );
    state = r2.state;
    events.push(...r2.events.map((e) => e.event));

    const r3 = processToolCalls(
      state,
      [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"V"}' }],
      MODEL_ID,
      MESSAGE_ID,
    );
    state = r3.state;
    events.push(...r3.events.map((e) => e.event));

    const r4 = processFinish(state, "tool_calls");
    state = r4.state;

    const r5 = processUsage(state, {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    state = r5.state;
    events.push(...r5.events.map((e) => e.event));

    expect(events).toEqual([
      // Thinking block opens
      "message_start",
      "content_block_start",
      "content_block_delta",
      // Text block opens (closes thinking)
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      // Tool use block opens (closes text), emits delta + stop
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      // Terminal pair (no open block to close)
      "message_delta",
      "message_stop",
    ]);

    const finalDelta = r5.events.find((e) => e.event === "message_delta");
    expect(finalDelta?.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
    });
  });
});
