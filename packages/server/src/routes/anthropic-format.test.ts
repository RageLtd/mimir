import { describe, expect, test } from "bun:test";
import { normalizeAnthropicRequest } from "./anthropic-format";

describe("normalizeAnthropicRequest — text-only", () => {
  test("simple user string content", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(result.systemPrompt).toBeUndefined();
  });

  test("user array content with text block", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello there" }],
        },
      ],
    });

    expect(result.messages).toEqual([{ role: "user", content: "Hello there" }]);
  });

  test("user array content with multiple text blocks joins with newline", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
          ],
        },
      ],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "First\nSecond" },
    ]);
  });

  test("assistant string content", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello back" },
      ],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello back" },
    ]);
  });

  test("assistant array content with text block", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello back" }],
        },
      ],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello back" },
    ]);
  });

  test("system as string", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.systemPrompt).toBe("You are a helpful assistant.");
  });

  test("system as array of text blocks joined", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      system: [
        { type: "text", text: "Part one." },
        { type: "text", text: "Part two." },
      ],
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.systemPrompt).toBe("Part one.\nPart two.");
  });

  test("empty system field produces undefined systemPrompt", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      system: "",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.systemPrompt).toBeUndefined();
  });

  test("multi-turn alternating conversation", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Second" },
      ],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Reply" },
      { role: "user", content: "Second" },
    ]);
  });

  test("model and stream fields pass through on the result object", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.model).toBe("glm-5.1");
    expect(result.stream).toBe(true);
  });

  test("stream defaults to false when omitted", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.stream).toBe(false);
  });
});

describe("normalizeAnthropicRequest — tool definitions", () => {
  test("translates Anthropic tool definitions to OpenAI shape", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather please" }],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });

    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ]);
  });

  test("tools field undefined when no tools supplied", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.tools).toBeUndefined();
  });

  test("tool without description still translates", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          name: "minimal_tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    expect(result.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "minimal_tool", description: undefined },
    });
  });
});

describe("normalizeAnthropicRequest — assistant tool_use blocks", () => {
  test("assistant with text + tool_use translates to AI SDK assistant with text + tool-call parts", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "Vancouver" },
            },
          ],
        },
      ],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "weather please" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool-call",
            toolCallId: "toolu_1",
            toolName: "get_weather",
            input: { city: "Vancouver" },
          },
        ],
      },
    ]);
  });

  test("assistant with only tool_use (no text) produces assistant message with single tool-call part", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "V" },
            },
          ],
        },
      ],
    });

    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "toolu_1",
          toolName: "get_weather",
          input: { city: "V" },
        },
      ],
    });
  });
});

describe("normalizeAnthropicRequest — user tool_result blocks", () => {
  test("user with tool_result content (string) produces a tool message before any user text", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "V" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "rainy" },
          ],
        },
      ],
    });

    expect(result.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_1",
          toolName: "get_weather",
          output: { type: "text", value: "rainy" },
        },
      ],
    });
  });

  test("user with tool_result array content (text blocks) joins to string", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "result A" },
                { type: "text", text: "result B" },
              ],
            },
          ],
        },
      ],
    });

    expect(result.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_1",
          toolName: "search",
          output: { type: "text", value: "result A\nresult B" },
        },
      ],
    });
  });

  test("is_error: true prefixes output value with 'Error: '", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "rate limited",
              is_error: true,
            },
          ],
        },
      ],
    });

    expect(result.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_1",
          toolName: "search",
          output: { type: "text", value: "Error: rate limited" },
        },
      ],
    });
  });

  test("user message with text + tool_result emits tool message and a separate user message", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
            { type: "text", text: "thanks, follow up question" },
          ],
        },
      ],
    });

    // Expect: assistant tool-call, tool result, then a separate user text message
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toMatchObject({ role: "tool" });
    expect(result.messages[2]).toEqual({
      role: "user",
      content: "thanks, follow up question",
    });
  });

  test("tool_result without matching tool_use_id resolves toolName to 'unknown'", () => {
    const result = normalizeAnthropicRequest({
      model: "glm-5.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "orphan", content: "data" },
          ],
        },
      ],
    });

    expect(result.messages[0]).toMatchObject({
      role: "tool",
      content: [
        expect.objectContaining({
          toolCallId: "orphan",
          toolName: "unknown",
        }),
      ],
    });
  });
});
