import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import type { MimirContext } from "../../middleware/types";
import { executeServerTools, type EmitSSE } from "./loop";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal MimirContext with stubbed server tools. */
function makeCtx(
  tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>,
): MimirContext {
  return {
    serverTools: tools as unknown as MimirContext["serverTools"],
    clientTools: {} as MimirContext["clientTools"],
    allTools: {} as MimirContext["allTools"],
    request: { model: "test-model" } as MimirContext["request"],
    project: "test",
    systemPrompt: "",
    memories: null,
    playbooks: null,
    projectRules: null,
    conversationMessages: [],
    contextInjection: [],
    compactionTriggered: false,
    resolvedModel: null,
  } satisfies MimirContext;
}

/** Create an emitSSE that captures deltas. */
function captureSSE() {
  const emissions: Record<string, unknown>[] = [];
  const emitSSE: EmitSSE = (delta) => {
    emissions.push(delta);
  };
  return { emitSSE, emissions };
}

// ── executeServerTools: tool observations ──────────────────────────────────────

describe("executeServerTools: tool observations", () => {
  test("emits one mimir_tool_observation per tool call", async () => {
    const tool = {
      execute: async (_input: unknown) => "memory saved",
    };
    const ctx = makeCtx({ save_memory: tool });
    const { emitSSE, emissions } = captureSSE();
    const prompt: LanguageModelV3Message[] = [];

    await executeServerTools(
      prompt,
      [
        {
          toolCallId: "call_abc",
          toolName: "save_memory",
          input: JSON.stringify({ content: "test memory" }),
        },
      ],
      ctx,
      emitSSE,
    );

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toEqual({
      mimir_tool_observation: {
        id: "call_abc",
        name: "save_memory",
        input: { content: "test memory" },
        result: "memory saved",
      },
    });
  });

  test("emits observations for multiple tool calls in order", async () => {
    const tool1 = { execute: async (_: unknown) => "result 1" };
    const tool2 = { execute: async (_: unknown) => "result 2" };
    const ctx = makeCtx({ tool_a: tool1, tool_b: tool2 });
    const { emitSSE, emissions } = captureSSE();
    const prompt: LanguageModelV3Message[] = [];

    await executeServerTools(
      prompt,
      [
        { toolCallId: "call_1", toolName: "tool_a", input: JSON.stringify({ x: 1 }) },
        { toolCallId: "call_2", toolName: "tool_b", input: JSON.stringify({ y: 2 }) },
      ],
      ctx,
      emitSSE,
    );

    expect(emissions).toHaveLength(2);
    expect(emissions[0]).toEqual({
      mimir_tool_observation: {
        id: "call_1",
        name: "tool_a",
        input: { x: 1 },
        result: "result 1",
      },
    });
    expect(emissions[1]).toEqual({
      mimir_tool_observation: {
        id: "call_2",
        name: "tool_b",
        input: { y: 2 },
        result: "result 2",
      },
    });
  });

  test("emits observation with error result when tool has no execute function", async () => {
    const ctx = makeCtx({
      broken_tool: {} as unknown as { execute: (input: unknown) => Promise<unknown> },
    });
    const { emitSSE, emissions } = captureSSE();
    const prompt: LanguageModelV3Message[] = [];

    await executeServerTools(
      prompt,
      [{ toolCallId: "call_err", toolName: "broken_tool", input: "{}" }],
      ctx,
      emitSSE,
    );

    expect(emissions).toHaveLength(1);
    const obs = emissions[0]?.mimir_tool_observation as Record<string, unknown>;
    expect(obs.id).toBe("call_err");
    expect(obs.name).toBe("broken_tool");
    expect(obs.result).toContain("no execute function");
  });

  test("emits observation with error result when tool throws", async () => {
    const tool = {
      execute: async () => {
        throw new Error("boom");
      },
    };
    const ctx = makeCtx({ exploding: tool });
    const { emitSSE, emissions } = captureSSE();
    const prompt: LanguageModelV3Message[] = [];

    await executeServerTools(
      prompt,
      [{ toolCallId: "call_throw", toolName: "exploding", input: "{}" }],
      ctx,
      emitSSE,
    );

    expect(emissions).toHaveLength(1);
    const obs = emissions[0]?.mimir_tool_observation as Record<string, unknown>;
    expect(obs.id).toBe("call_throw");
    expect(obs.result).toContain("boom");
  });

  test("appends tool results to prompt after emission", async () => {
    const tool = { execute: async (_: unknown) => "saved" };
    const ctx = makeCtx({ save: tool });
    const { emitSSE } = captureSSE();
    const prompt: LanguageModelV3Message[] = [];

    await executeServerTools(
      prompt,
      [{ toolCallId: "call_p", toolName: "save", input: JSON.stringify({ key: "val" }) }],
      ctx,
      emitSSE,
    );

    // Prompt should have a tool message with the result
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.role).toBe("tool");
  });

  test("coerces non-string tool results to JSON strings", async () => {
    const tool = {
      execute: async (_: unknown) => ({ files: ["a.ts", "b.ts"] }),
    };
    const ctx = makeCtx({ list_files: tool });
    const { emitSSE, emissions } = captureSSE();
    const prompt: LanguageModelV3Message[] = [];

    await executeServerTools(
      prompt,
      [{ toolCallId: "call_json", toolName: "list_files", input: "{}" }],
      ctx,
      emitSSE,
    );

    const obs = emissions[0]?.mimir_tool_observation as Record<string, unknown>;
    expect(obs.result).toBe('{"files":["a.ts","b.ts"]}');
  });
});
