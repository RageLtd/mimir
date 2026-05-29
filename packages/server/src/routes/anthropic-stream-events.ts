/**
 * Anthropic SSE event constructors.
 *
 * Pure data builders for every Anthropic Messages API streaming event
 * the state machine emits. Lives separate from the state machine
 * (`anthropic-stream.ts`) so the vocabulary of wire-format events is
 * isolated from the logic that sequences them.
 */

export type AnthropicEvent = {
  event: string;
  data: Record<string, unknown>;
};

export const buildMessageStart = (modelId: string, messageId: string) => ({
  event: "message_start",
  data: {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: modelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  },
});

export const buildContentBlockStartText = (index: number) => ({
  event: "content_block_start",
  data: {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  },
});

export const buildContentBlockStartThinking = (index: number) => ({
  event: "content_block_start",
  data: {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "" },
  },
});

export const buildContentBlockStartToolUse = (
  index: number,
  id: string,
  name: string,
) => ({
  event: "content_block_start",
  data: {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  },
});

export const buildTextDelta = (index: number, text: string) => ({
  event: "content_block_delta",
  data: {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  },
});

export const buildThinkingDelta = (index: number, thinking: string) => ({
  event: "content_block_delta",
  data: {
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  },
});

export const buildInputJsonDelta = (index: number, partialJson: string) => ({
  event: "content_block_delta",
  data: {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  },
});

export const buildContentBlockStop = (index: number) => ({
  event: "content_block_stop",
  data: { type: "content_block_stop", index },
});

export const buildMessageDelta = (
  stopReason: string,
  inputTokens: number,
  outputTokens: number,
) => ({
  event: "message_delta",
  data: {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  },
});

export const buildMessageStop = () => ({
  event: "message_stop",
  data: { type: "message_stop" },
});
