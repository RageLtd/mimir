/**
 * Regression tests for the replay race.
 *
 * Context assembly (persist trailing turn + read the log) must run INSIDE
 * the LLM-call queue. If it ran at route time, a request arriving while
 * another turn streams would snapshot history before the in-flight
 * assistant reply landed — the model would answer against a conversation
 * missing the previous exchange.
 *
 * These tests drive two concurrent streamingResponse calls through the
 * real queue with a gated fake model and assert strict serialization:
 * assemble(1) → doStream(1) → [turn 1 completes] → assemble(2) → doStream(2).
 */

import { describe, expect, mock, test } from "bun:test";
import type { MimirContext } from "../../middleware/types";

const events: string[] = [];

mock.module("../../middleware/context-assembly", () => ({
  assembleContext: async (ctx: MimirContext) => {
    events.push(`assemble:${ctx.request.model}`);
  },
  buildContextInjection: () => [],
}));

mock.module("../post-processing", () => ({
  classifyToolCalls: (toolCalls: Array<Record<string, unknown>>) => ({
    serverCalls: [],
    clientCalls: toolCalls,
  }),
  finalizeTurn: () => {},
}));

const { streamingResponse } = await import("./response");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(model: string): MimirContext {
  return {
    request: {
      model,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
    projectId: "test",
    systemPrompt: "system",
    memories: null,
    playbooks: null,
    projectRules: null,
    conversationMessages: [],
    contextInjection: [],
    compactionTriggered: false,
    serverTools: {},
    clientTools: {},
    allTools: {},
    resolvedModel: null,
  };
}

const finishPart = {
  type: "finish" as const,
  finishReason: { unified: "stop" },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
};

/** Fake model whose doStream logs its call and optionally waits on a gate. */
function makeModel(name: string, gate?: Promise<void>) {
  return {
    doStream: async () => {
      events.push(`doStream:${name}`);
      if (gate) await gate;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", delta: "ok" });
            controller.enqueue(finishPart);
            controller.close();
          },
        }),
      };
    },
    doGenerate: async () => {
      throw new Error("doGenerate is not used by the agent loop");
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("streamingResponse: assembly serialized with the LLM call", () => {
  test("second request does not assemble until the first turn completes", async () => {
    events.length = 0;

    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const res1 = streamingResponse(makeModel("m1", gate), makeCtx("m1"));
    const res2 = streamingResponse(makeModel("m2"), makeCtx("m2"));

    // Give the queue a tick: turn 1 should be mid-flight, turn 2 waiting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toContain("assemble:m1");
    expect(events).toContain("doStream:m1");
    expect(events).not.toContain("assemble:m2");

    releaseFirst();
    const [body1, body2] = await Promise.all([res1.text(), res2.text()]);

    expect(events).toEqual([
      "assemble:m1",
      "doStream:m1",
      "assemble:m2",
      "doStream:m2",
    ]);
    expect(body1).toContain("data: [DONE]");
    expect(body2).toContain("data: [DONE]");
  });

  test("assembly failure surfaces as an in-stream error, and the queue advances", async () => {
    events.length = 0;

    // Poison the first turn's assembly via a model whose ctx triggers it:
    // simplest is to make assembleContext throw for a marker model id.
    const { streamingResponse: run } = await import("./response");
    mock.module("../../middleware/context-assembly", () => ({
      assembleContext: async (ctx: MimirContext) => {
        if (ctx.request.model === "poison") {
          throw new Error("failed to persist the trailing turn");
        }
        events.push(`assemble:${ctx.request.model}`);
      },
      buildContextInjection: () => [],
    }));

    const resPoison = run(makeModel("poison"), makeCtx("poison"));
    const resNext = run(makeModel("m3"), makeCtx("m3"));

    const [poisonBody, nextBody] = await Promise.all([
      resPoison.text(),
      resNext.text(),
    ]);

    // The failed turn reports its error in-stream and still terminates.
    expect(poisonBody).toContain("failed to persist the trailing turn");
    expect(poisonBody).toContain("data: [DONE]");

    // The queue is not wedged — the next turn runs to completion.
    expect(events).toEqual(["assemble:m3", "doStream:m3"]);
    expect(nextBody).toContain("data: [DONE]");
  });
});
