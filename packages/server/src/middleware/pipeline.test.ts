import { describe, expect, test } from "bun:test";
import {
  createMimirContext,
  extractProviderOverride,
  requireProjectId,
} from "./pipeline";
import type { ChatRequest, MimirContext } from "./types";

const baseRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  ...overrides,
});

describe("createMimirContext", () => {
  test("starts with projectId unresolved — resolution is a pipeline stage", () => {
    const ctx = createMimirContext(baseRequest());
    expect(ctx.projectId).toBeNull();
  });

  test("starts with an empty pipeline state", () => {
    const ctx = createMimirContext(baseRequest());
    expect(ctx.systemPrompt).toBe("");
    expect(ctx.memories).toBeNull();
    expect(ctx.playbooks).toBeNull();
    expect(ctx.projectRules).toBeNull();
    expect(ctx.conversationMessages).toEqual([]);
    expect(ctx.contextInjection).toEqual([]);
    expect(ctx.compactionTriggered).toBe(false);
    expect(Object.keys(ctx.serverTools)).toHaveLength(0);
    expect(Object.keys(ctx.clientTools)).toHaveLength(0);
    expect(Object.keys(ctx.allTools)).toHaveLength(0);
    expect(ctx.resolvedModel).toBeNull();
  });
});

describe("extractProviderOverride", () => {
  test("no header → null (keyless path unchanged)", () => {
    expect(extractProviderOverride(undefined, {})).toBeNull();
    expect(extractProviderOverride("", { provider: "anthropic" })).toBeNull();
    expect(extractProviderOverride("   ", {})).toBeNull();
  });

  test("header alone → apiKey-only override", () => {
    expect(extractProviderOverride("sk-user", {})).toEqual({
      apiKey: "sk-user",
    });
  });

  test("header + metadata → full override", () => {
    expect(
      extractProviderOverride("sk-user", {
        provider: "anthropic",
        base_url: "http://llm.internal/v1",
      }),
    ).toEqual({
      apiKey: "sk-user",
      provider: "anthropic",
      baseUrl: "http://llm.internal/v1",
    });
  });

  test("createMimirContext threads the override onto ctx", () => {
    const override = { apiKey: "sk-user" };
    const ctx = createMimirContext(baseRequest(), {
      providerOverride: override,
    });
    expect(ctx.providerOverride).toBe(override);
    expect(createMimirContext(baseRequest()).providerOverride).toBeNull();
  });
});

describe("requireProjectId", () => {
  test("throws before the resolve stage has run", () => {
    const ctx: MimirContext = createMimirContext(baseRequest());
    expect(() => requireProjectId(ctx)).toThrow(/not resolved/);
  });

  test("returns the resolved id once set", () => {
    const ctx: MimirContext = createMimirContext(baseRequest());
    ctx.projectId = "01TESTULID";
    expect(requireProjectId(ctx)).toBe("01TESTULID");
  });
});
