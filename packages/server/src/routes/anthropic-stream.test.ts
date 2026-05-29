import { describe, expect, test } from "bun:test";
import {
  type AnthropicStreamState,
  initialAnthropicStreamState,
  processFinish,
  processTextDelta,
  processUsage,
} from "./anthropic-stream";

const MESSAGE_ID = "msg_test123";
const MODEL_ID = "glm-5.1";

describe("processTextDelta", () => {
  test("first text delta emits message_start + content_block_start + content_block_delta", () => {
    const result = processTextDelta(
      initialAnthropicStreamState(),
      "Hello",
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(result.events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ]);

    const [start, blockStart, blockDelta] = result.events;
    expect(start?.data).toMatchObject({
      type: "message_start",
      message: {
        id: MESSAGE_ID,
        type: "message",
        role: "assistant",
        content: [],
        model: MODEL_ID,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    expect(blockStart?.data).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(blockDelta?.data).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });

    expect(result.state.messageStarted).toBe(true);
    expect(result.state.currentBlockIndex).toBe(0);
    expect(result.state.currentBlockType).toBe("text");
  });

  test("second text delta into an open text block only emits content_block_delta", () => {
    const first = processTextDelta(
      initialAnthropicStreamState(),
      "Hello",
      MODEL_ID,
      MESSAGE_ID,
    );
    const second = processTextDelta(
      first.state,
      " world",
      MODEL_ID,
      MESSAGE_ID,
    );

    expect(second.events.map((e) => e.event)).toEqual(["content_block_delta"]);
    expect(second.events[0]?.data).toMatchObject({
      delta: { type: "text_delta", text: " world" },
    });
    expect(second.state.currentBlockIndex).toBe(0);
  });
});

describe("processFinish", () => {
  test("records finishReason in state and emits no events", () => {
    const after = processTextDelta(
      initialAnthropicStreamState(),
      "Hi",
      MODEL_ID,
      MESSAGE_ID,
    );

    const result = processFinish(after.state, "stop");

    expect(result.events).toEqual([]);
    expect(result.state.pendingFinishReason).toBe("stop");
  });
});

describe("processUsage", () => {
  test("closes open text block, emits message_delta + message_stop with translated stop_reason", () => {
    const afterText = processTextDelta(
      initialAnthropicStreamState(),
      "Hi",
      MODEL_ID,
      MESSAGE_ID,
    );
    const afterFinish = processFinish(afterText.state, "stop");

    const result = processUsage(afterFinish.state, {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
    });

    expect(result.events.map((e) => e.event)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const [blockStop, msgDelta, msgStop] = result.events;
    expect(blockStop?.data).toMatchObject({
      type: "content_block_stop",
      index: 0,
    });
    expect(msgDelta?.data).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    expect(msgStop?.data).toMatchObject({ type: "message_stop" });

    expect(result.state.currentBlockType).toBe(null);
  });

  test("translates length finishReason to max_tokens", () => {
    const afterText = processTextDelta(
      initialAnthropicStreamState(),
      "Hi",
      MODEL_ID,
      MESSAGE_ID,
    );
    const afterFinish = processFinish(afterText.state, "length");

    const result = processUsage(afterFinish.state, {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
    });

    const msgDelta = result.events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data).toMatchObject({
      delta: { stop_reason: "max_tokens" },
    });
  });

  test("translates tool_calls / tool-calls finishReason to tool_use", () => {
    const afterText = processTextDelta(
      initialAnthropicStreamState(),
      "Hi",
      MODEL_ID,
      MESSAGE_ID,
    );

    const result1 = processUsage(
      processFinish(afterText.state, "tool_calls").state,
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    );
    expect(
      result1.events.find((e) => e.event === "message_delta")?.data,
    ).toMatchObject({ delta: { stop_reason: "tool_use" } });

    const result2 = processUsage(
      processFinish(afterText.state, "tool-calls").state,
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    );
    expect(
      result2.events.find((e) => e.event === "message_delta")?.data,
    ).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  test("no open block — skips content_block_stop, still emits message_delta + message_stop", () => {
    const afterFinish = processFinish(
      initialAnthropicStreamState(),
      "stop",
    );

    const result = processUsage(afterFinish.state, {
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
    });

    expect(result.events.map((e) => e.event)).toEqual([
      "message_delta",
      "message_stop",
    ]);
  });

  test("missing finishReason defaults to end_turn", () => {
    const afterText = processTextDelta(
      initialAnthropicStreamState(),
      "Hi",
      MODEL_ID,
      MESSAGE_ID,
    );

    const result = processUsage(afterText.state, {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    });

    const msgDelta = result.events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
    });
  });
});

describe("full text-only streaming sequence", () => {
  test("Hello world response produces canonical Anthropic SSE event order", () => {
    const events: string[] = [];

    let state: AnthropicStreamState = initialAnthropicStreamState();

    let r = processTextDelta(state, "Hello", MODEL_ID, MESSAGE_ID);
    state = r.state;
    events.push(...r.events.map((e) => e.event));

    r = processTextDelta(state, " world", MODEL_ID, MESSAGE_ID);
    state = r.state;
    events.push(...r.events.map((e) => e.event));

    r = processFinish(state, "stop");
    state = r.state;
    events.push(...r.events.map((e) => e.event));

    r = processUsage(state, {
      prompt_tokens: 50,
      completion_tokens: 2,
      total_tokens: 52,
    });
    state = r.state;
    events.push(...r.events.map((e) => e.event));

    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});
