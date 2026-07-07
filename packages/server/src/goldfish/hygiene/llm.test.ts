/**
 * Hygiene LLM BYOK routing tests (MIM-75 Part 1). runOverrideCompletion is
 * mocked — these pin the branch contract: a byok context routes merge and
 * classify calls through the override path with the caller's model and key,
 * a keyed failure returns null WITHOUT falling back to the env transport
 * (MIM-74's hard rule), and the keyless path never touches the override.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const overrideSpy = mock<(opts: unknown) => Promise<string | null>>(
  async () => "merged text",
);
// Explicit export list — anything llm.ts imports from override-completion
// must appear here or every transitive importer fails at load.
mock.module("../../agent/provider/override-completion", () => ({
  runOverrideCompletion: overrideSpy,
  resolveOverrideModelId: (o: { smallModel?: string }, r?: string) =>
    o.smallModel ?? r ?? null,
}));

import { classifyPair, type HygieneByok, mergeMemoriesText } from "./llm";

const byok: HygieneByok = {
  override: { apiKey: "sk-user", provider: "anthropic" },
  modelId: "anthropic/claude-sonnet-4-5",
};

describe("hygiene BYOK routing", () => {
  beforeEach(() => {
    overrideSpy.mockClear();
    overrideSpy.mockResolvedValue("merged text");
  });

  test("keyed merge runs on the caller's model and key", async () => {
    const merged = await mergeMemoriesText(["fact one", "fact two"], byok);
    expect(merged).toBe("merged text");
    expect(overrideSpy).toHaveBeenCalledTimes(1);
    const call = overrideSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.modelId).toBe(byok.modelId);
    expect(call.override).toEqual(byok.override);
    expect(String(call.system)).toContain("consolidate");
    expect(String(call.user)).toContain("1. fact one");
    expect(String(call.user)).toContain("2. fact two");
  });

  test("keyed classify parses the verdict from the override completion", async () => {
    overrideSpy.mockResolvedValue(
      '{"action":"demote","survivor":2,"reason":"newer value wins"}',
    );
    const verdict = await classifyPair("old claim", "new claim", byok);
    expect(verdict).toEqual({
      action: "demote",
      survivor: 2,
      reason: "newer value wins",
    });
    expect(overrideSpy).toHaveBeenCalledTimes(1);
  });

  test("keyed failure returns null and never falls back to the env transport", async () => {
    overrideSpy.mockResolvedValue(null);
    const fetchSpy = mock(() => {
      throw new Error("env transport must not be reached on a keyed failure");
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const merged = await mergeMemoriesText(["a", "b"], byok);
      expect(merged).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("keyless call skips the override path entirely", async () => {
    // Stub fetch: the repo .env may or may not carry HYGIENE_MODEL, so the
    // env transport must be inert either way — this test only pins that the
    // override path is never touched without a key.
    const fetchStub = mock(async () =>
      Response.json({ choices: [{ message: { content: "env text" } }] }),
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      await mergeMemoriesText(["a", "b"]);
      expect(overrideSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
