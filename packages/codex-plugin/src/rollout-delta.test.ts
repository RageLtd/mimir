import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDelta, readWatermark, writeWatermark } from "./rollout-delta";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "test-fixtures",
  "rollout-basic-session.jsonl",
);

// Watermark helpers write under mimirHome() — isolate the suite.
let previousMimirHome: string | undefined;
let sandbox: string;

beforeAll(() => {
  previousMimirHome = process.env.MIMIR_HOME;
  sandbox = mkdtempSync(join(tmpdir(), "mimir-codex-rollout-test-"));
  process.env.MIMIR_HOME = sandbox;
});

afterAll(() => {
  if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousMimirHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("readDelta against the captured 0.144.0 rollout", () => {
  test("converts the full session, filtering scaffolding and reasoning", async () => {
    const { messages, newOffset } = await readDelta(FIXTURE, 0);

    // Fixture: 27 non-empty lines total.
    expect(newOffset).toBe(27);

    // 3 developer messages dropped; 1 user message whose parts are all
    // scaffolding (<recommended_plugins> + <environment_context>) dropped;
    // reasoning dropped. Survivors: 1 real user, 2 assistant texts,
    // 3 tool calls, 3 tool results.
    expect(messages).toHaveLength(9);

    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toContain("Read greet.ts");
    expect(JSON.stringify(userMessages[0]?.content)).not.toContain(
      "environment_context",
    );

    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(3);
  });

  test("pairs tool outputs with their call's tool name", async () => {
    const { messages } = await readDelta(FIXTURE, 0);
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const part = Array.isArray(toolMessage?.content)
      ? toolMessage.content[0]
      : undefined;
    expect(part?.type).toBe("tool-result");
    if (part?.type === "tool-result") {
      // custom_tool_call in the fixture is named "exec".
      expect(part.toolName).toBe("exec");
      // Output was a JSON-encoded content-part array — decoded to text.
      expect(part.output).toEqual({
        type: "text",
        value: expect.stringContaining("Script completed"),
      });
    }
  });

  test("assistant tool calls carry the raw code-mode input as an object", async () => {
    const { messages } = await readDelta(FIXTURE, 0);
    const withToolCall = messages.filter(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "tool-call"),
    );
    expect(withToolCall).toHaveLength(3);
    const first = withToolCall[0];
    const part = Array.isArray(first?.content) ? first.content[0] : undefined;
    if (part?.type === "tool-call") {
      expect(part.toolName).toBe("exec");
      expect(part.input).toHaveProperty("input");
    }
  });

  test("watermark past the end yields an empty delta", async () => {
    const { messages, newOffset } = await readDelta(FIXTURE, 27);
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(27);
  });

  test("mid-file watermark only converts the tail", async () => {
    const full = await readDelta(FIXTURE, 0);
    const tail = await readDelta(FIXTURE, 20);
    expect(tail.newOffset).toBe(27);
    expect(tail.messages.length).toBeGreaterThan(0);
    expect(tail.messages.length).toBeLessThan(full.messages.length);
  });

  test("missing rollout returns the watermark unchanged", async () => {
    const { messages, newOffset } = await readDelta(
      join(sandbox, "does-not-exist.jsonl"),
      5,
    );
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(5);
  });
});

describe("watermark persistence", () => {
  test("roundtrips and defaults to 0", async () => {
    expect(await readWatermark("codex-session-a")).toBe(0);
    await writeWatermark("codex-session-a", 42);
    expect(await readWatermark("codex-session-a")).toBe(42);
  });

  test("garbage state file degrades to 0", async () => {
    await writeWatermark("codex-session-b", 7);
    await Bun.write(
      join(sandbox, "persist-state", "codex-session-b.json"),
      "not json",
    );
    expect(await readWatermark("codex-session-b")).toBe(0);
  });
});
