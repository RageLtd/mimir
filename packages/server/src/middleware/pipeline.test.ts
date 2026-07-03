import { describe, expect, test } from "bun:test";
import { createMimirContext } from "./pipeline";
import type { ChatRequest } from "./types";

const baseRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  ...overrides,
});

describe("createMimirContext", () => {
  test("defaults project when metadata is absent", () => {
    const ctx = createMimirContext(baseRequest());
    expect(ctx.project).toBe("default");
  });

  test("reads project from request metadata", () => {
    const ctx = createMimirContext(
      baseRequest({ metadata: { project: "/Users/rage/proj" } }),
    );
    expect(ctx.project).toBe("/Users/rage/proj");
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
