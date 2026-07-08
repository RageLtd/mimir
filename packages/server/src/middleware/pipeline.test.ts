import { describe, expect, test } from "bun:test";
import { testScope } from "../testing/scope";
import {
  createMimirContext,
  extractProviderOverride,
  requireProjectId,
} from "./pipeline";
import type { ChatRequest, MimirContext } from "./types";

const scope = testScope();

const baseRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  ...overrides,
});

describe("createMimirContext", () => {
  test("starts with projectId unresolved — resolution is a pipeline stage", () => {
    const ctx = createMimirContext(baseRequest(), { scope });
    expect(ctx.projectId).toBeNull();
  });

  test("starts with an empty pipeline state", () => {
    const ctx = createMimirContext(baseRequest(), { scope });
    expect(ctx.systemPrompt).toBe("");
    expect(ctx.memories).toBeNull();
    expect(ctx.playbooks).toBeNull();
    expect(ctx.projectRules).toBeNull();
    expect(ctx.conversationMessages).toEqual([]);
    expect(ctx.contextInjection).toEqual([]);
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

  test("metadata.small_model rides the override for background jobs (MIM-74)", () => {
    expect(
      extractProviderOverride("sk-user", {
        provider: "anthropic",
        small_model: "anthropic/claude-haiku",
      }),
    ).toEqual({
      apiKey: "sk-user",
      provider: "anthropic",
      smallModel: "anthropic/claude-haiku",
    });
    // Empty string is unset, not an override
    expect(
      extractProviderOverride("sk-user", { small_model: "" }),
    ).toEqual({ apiKey: "sk-user" });
  });

  test("createMimirContext threads the override onto ctx", () => {
    const override = { apiKey: "sk-user" };
    const ctx = createMimirContext(baseRequest(), {
      scope,
      providerOverride: override,
    });
    expect(ctx.providerOverride).toBe(override);
    expect(createMimirContext(baseRequest(), { scope }).providerOverride).toBeNull();
  });
});

describe("requireProjectId", () => {
  test("throws before the resolve stage has run", () => {
    const ctx: MimirContext = createMimirContext(baseRequest(), { scope });
    expect(() => requireProjectId(ctx)).toThrow(/not resolved/);
  });

  test("returns the resolved id once set", () => {
    const ctx: MimirContext = createMimirContext(baseRequest(), { scope });
    ctx.projectId = "01TESTULID";
    expect(requireProjectId(ctx)).toBe("01TESTULID");
  });
});
