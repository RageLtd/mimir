/**
 * Memory extraction BYOK tests (MIM-74). The BYOK helper and the small-model
 * config are mocked; global fetch is stubbed for the env raw-fetch path.
 * Pins the branch contract: keyed → user's key only (no operator fallback
 * on failure); keyless or hint-less → env path exactly as before.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockRunOverrideCompletion = mock<
  (opts: { modelId: string }) => Promise<string | null>
>(() => Promise.resolve('["byok fact"]'));
mock.module("../agent/provider/override-completion", () => ({
  runOverrideCompletion: mockRunOverrideCompletion,
  resolveOverrideModelId: (
    override: { smallModel?: string },
    requestModelId?: string,
  ) => override.smallModel ?? requestModelId ?? null,
}));

const mockGetSmallModelConfig = mock<
  () => { baseUrl: string; apiKey: string; model: string } | null
>(() => ({
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "qwen3.5:9b",
}));
mock.module("../agent/provider/query", () => ({
  getSmallModelConfig: mockGetSmallModelConfig,
  resolveEmbeddingModel: () => {
    throw new Error("not under test");
  },
}));

mock.module("../config", () => ({
  config: { embedding: { type: "openai", dimensions: 1024 } },
}));

const mockFetch = mock(async () => ({
  json: async () => ({
    choices: [{ message: { content: '["env fact"]' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
}));
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

import { extractMemories } from "./clients";

describe("extractMemories BYOK (MIM-74)", () => {
  beforeEach(() => {
    mockRunOverrideCompletion.mockClear();
    mockGetSmallModelConfig.mockClear();
    mockFetch.mockClear();
  });

  const conversationText = "user: real question\nassistant: real answer";

  test("keyed turn extracts on the user's key — env path untouched", async () => {
    const memories = await extractMemories(conversationText, {
      override: { apiKey: "sk-user", smallModel: "anthropic/haiku" },
      requestModelId: "anthropic/opus",
    });

    expect(memories).toEqual(["byok fact"]);
    expect(mockRunOverrideCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "anthropic/haiku" }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("no small_model → the turn's request model carries the job", async () => {
    await extractMemories(conversationText, {
      override: { apiKey: "sk-user" },
      requestModelId: "anthropic/opus",
    });
    expect(mockRunOverrideCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "anthropic/opus" }),
    );
  });

  test("keyed failure returns [] — never falls back to the operator's model", async () => {
    mockRunOverrideCompletion.mockResolvedValueOnce(null);
    const memories = await extractMemories(conversationText, {
      override: { apiKey: "sk-user", smallModel: "anthropic/haiku" },
    });
    expect(memories).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("key without any model hint degrades to the env path", async () => {
    const memories = await extractMemories(conversationText, {
      override: { apiKey: "sk-user" },
    });
    expect(memories).toEqual(["env fact"]);
    expect(mockRunOverrideCompletion).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  test("keyless call uses the env small model exactly as before", async () => {
    const memories = await extractMemories(conversationText);
    expect(memories).toEqual(["env fact"]);
    expect(mockRunOverrideCompletion).not.toHaveBeenCalled();
  });
});
