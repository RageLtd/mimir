/**
 * BYOK background completion tests (MIM-74). generateText and the BYOK
 * model resolver are mocked — these tests pin the helper's contract:
 * model-id precedence, parameter wiring, and null-on-failure (never
 * throw, never fall back to operator-funded inference).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockGenerateText = mock(async (_opts: Record<string, unknown>) => ({
  text: "completion text",
  usage: { inputTokens: 10, outputTokens: 5 },
}));
mock.module("ai", () => ({ generateText: mockGenerateText }));

const mockResolveModel = mock(
  (modelId: string, _override: Record<string, unknown>) => ({ modelId }),
);
mock.module("./query", () => ({
  resolveModelWithOverride: mockResolveModel,
}));

import {
  resolveOverrideModelId,
  runOverrideCompletion,
} from "./override-completion";

describe("resolveOverrideModelId", () => {
  test("client-designated small model wins", () => {
    expect(
      resolveOverrideModelId(
        { apiKey: "sk", smallModel: "anthropic/haiku" },
        "anthropic/opus",
      ),
    ).toBe("anthropic/haiku");
  });

  test("falls back to the turn's request model", () => {
    expect(resolveOverrideModelId({ apiKey: "sk" }, "anthropic/opus")).toBe(
      "anthropic/opus",
    );
  });

  test("null when neither is known — callers treat as keyless", () => {
    expect(resolveOverrideModelId({ apiKey: "sk" })).toBeNull();
  });
});

describe("runOverrideCompletion", () => {
  beforeEach(() => {
    mockGenerateText.mockClear();
    mockResolveModel.mockClear();
  });

  const override = { apiKey: "sk-user", provider: "anthropic" };
  const baseOpts = {
    system: "You summarize.",
    user: "conversation text",
    maxOutputTokens: 2048,
    timeoutMs: 60_000,
    modelId: "anthropic/haiku",
    override,
  };

  test("resolves the model on the user's key and returns the text", async () => {
    const content = await runOverrideCompletion(baseOpts);
    expect(content).toBe("completion text");

    expect(mockResolveModel).toHaveBeenCalledWith("anthropic/haiku", override);
    const callOpts = mockGenerateText.mock.calls[0]?.[0];
    expect(callOpts).toMatchObject({
      system: "You summarize.",
      prompt: "conversation text",
      maxOutputTokens: 2048,
      temperature: 0.1,
    });
  });

  test("returns null when the provider call fails — no throw, no fallback", async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error("invalid x-api-key: sk-user"),
    );
    expect(await runOverrideCompletion(baseOpts)).toBeNull();
  });

  test("returns null when resolution throws synchronously", async () => {
    mockResolveModel.mockImplementationOnce(() => {
      throw new Error("BYOK: cannot determine provider");
    });
    expect(await runOverrideCompletion(baseOpts)).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("returns null on empty completion text", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "   ",
      usage: { inputTokens: 1, outputTokens: 0 },
    });
    expect(await runOverrideCompletion(baseOpts)).toBeNull();
  });
});
