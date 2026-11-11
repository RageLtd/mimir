import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDelta,
  readSummaryState,
  readWatermark,
  readWindow,
  writeSummaryState,
  writeWatermark,
} from "./rollout-delta";

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

  test("the AGENTS.md block Codex opens a session with is scaffolding, not a user turn", async () => {
    // Seen in every 0.144 rollout: one user record carrying the plugin
    // list, the project's AGENTS.md (the whole persona) and the environment.
    const userRecord = (...texts: string[]) =>
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: texts.map((text) => ({ type: "input_text", text })),
        },
      });
    const rollout = join(sandbox, "agents-scaffolding.jsonl");
    await Bun.write(
      rollout,
      [
        userRecord(
          "<recommended_plugins>\nnone\n</recommended_plugins>",
          "# AGENTS.md instructions for /work/repo\n\n<INSTRUCTIONS>\nYou are Mimir.\n</INSTRUCTIONS>",
          "<environment_context>\n  <cwd>/work/repo</cwd>\n</environment_context>",
        ),
        // With no project AGENTS.md the heading carries no path.
        userRecord(
          "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nYou are Mimir.\n</INSTRUCTIONS>",
        ),
        userRecord("Why is the embedder not downloading?"),
      ].join("\n"),
    );

    const { messages } = await readDelta(rollout, 0);

    expect(messages).toEqual([
      { role: "user", content: "Why is the embedder not downloading?" },
    ]);
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

const NO_SUMMARY = { summarizedThrough: 0, summaryId: null };

describe("summary state persistence — survives across hook processes", () => {
  const stateFile = (sessionId: string) =>
    join(sandbox, "persist-state", `${sessionId}.json`);

  test("roundtrips and defaults to no summary", async () => {
    expect(await readSummaryState("codex-session-c")).toEqual(NO_SUMMARY);
    const state = { summarizedThrough: 27, summaryId: "memory:summary-1" };
    await writeSummaryState("codex-session-c", state);
    expect(await readSummaryState("codex-session-c")).toEqual(state);
  });

  test("shares the session's state file with the watermark, neither clobbering the other", async () => {
    await writeWatermark("codex-session-d", 10);
    await writeSummaryState("codex-session-d", {
      summarizedThrough: 8,
      summaryId: "memory:summary-d",
    });
    await writeWatermark("codex-session-d", 12);

    expect(await readWatermark("codex-session-d")).toBe(12);
    expect(await readSummaryState("codex-session-d")).toEqual({
      summarizedThrough: 8,
      summaryId: "memory:summary-d",
    });
    expect(await Bun.file(stateFile("codex-session-d")).json()).toEqual({
      offset: 12,
      summarizedThrough: 8,
      summaryId: "memory:summary-d",
    });

    await writeSummaryState("codex-session-d", {
      summarizedThrough: 12,
      summaryId: "memory:summary-d2",
    });
    expect(await readWatermark("codex-session-d")).toBe(12);
  });

  test("a state file from before the fields existed reads no summary", async () => {
    await Bun.write(
      stateFile("codex-session-e"),
      JSON.stringify({ offset: 5 }),
    );
    expect(await readSummaryState("codex-session-e")).toEqual(NO_SUMMARY);
    expect(await readWatermark("codex-session-e")).toBe(5);
  });

  test("garbage state file degrades to no summary", async () => {
    await Bun.write(stateFile("codex-session-f"), "not json");
    expect(await readSummaryState("codex-session-f")).toEqual(NO_SUMMARY);
  });
});

describe("state writes are atomic", () => {
  // A fresh home so the directory listing holds only this suite's files.
  let outerHome: string | undefined;
  let home: string;
  const SESSION = "codex-session-atomic";
  const stateDir = () => join(home, "persist-state");

  beforeAll(() => {
    outerHome = process.env.MIMIR_HOME;
    home = mkdtempSync(join(tmpdir(), "mimir-codex-atomic-test-"));
    process.env.MIMIR_HOME = home;
  });

  afterAll(() => {
    process.env.MIMIR_HOME = outerHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("each write leaves a parseable file and no temp file behind", async () => {
    await writeWatermark(SESSION, 3);
    expect(readdirSync(stateDir())).toEqual([`${SESSION}.json`]);
    expect(await Bun.file(join(stateDir(), `${SESSION}.json`)).json()).toEqual({
      offset: 3,
    });

    await writeSummaryState(SESSION, {
      summarizedThrough: 2,
      summaryId: "memory:a",
    });
    expect(readdirSync(stateDir())).toEqual([`${SESSION}.json`]);
    expect(await Bun.file(join(stateDir(), `${SESSION}.json`)).json()).toEqual({
      offset: 3,
      summarizedThrough: 2,
      summaryId: "memory:a",
    });
  });

  test("concurrent watermark and summary writes never leave a torn file", async () => {
    // Seeded with all three fields: a reader that never sees a torn file
    // carries every field forward, whichever writer wins.
    await writeWatermark(SESSION, 1);
    await writeSummaryState(SESSION, {
      summarizedThrough: 1,
      summaryId: "memory:seed",
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? writeWatermark(SESSION, i)
          : writeSummaryState(SESSION, {
              summarizedThrough: i,
              summaryId: `memory:${i}`,
            }),
      ),
    );

    const raw = await Bun.file(join(stateDir(), `${SESSION}.json`)).text();
    const parsed = JSON.parse(raw);
    expect(typeof parsed.offset).toBe("number");
    expect(typeof parsed.summarizedThrough).toBe("number");
    expect(typeof parsed.summaryId).toBe("string");
    expect(readdirSync(stateDir())).toEqual([`${SESSION}.json`]);
  });
});

// ---------------------------------------------------------------------------
// readWindow — the conversation since the last compaction
// ---------------------------------------------------------------------------

const say = (role: "user" | "assistant", text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
const meta = (type: string, payloadType?: string) =>
  JSON.stringify({ type, payload: payloadType ? { type: payloadType } : {} });
const compacted = (windowNumber: number) =>
  JSON.stringify({
    type: "compacted",
    timestamp: "2026-11-10T00:00:00.000Z",
    payload: {
      message: "",
      replacement_history: [
        { type: "compaction", encrypted_content: "opaque" },
      ],
      window_number: windowNumber,
    },
  });
// What Codex appends right after a compacted record.
const afterCompaction = [
  meta("world_state"),
  meta("turn_context"),
  meta("event_msg", "token_count"),
  meta("event_msg", "context_compacted"),
];

const writeRollout = async (name: string, lines: string[]) => {
  const path = join(sandbox, name);
  await Bun.write(path, lines.join("\n"));
  return path;
};

describe("readWindow — conversation since the last compaction", () => {
  test("starts after the last compacted record, stripping scaffolding as readDelta does", async () => {
    const rollout = await writeRollout("window-one.jsonl", [
      meta("session_meta"), // 1
      say("user", "before the compaction"), // 2
      say("assistant", "an old answer"), // 3
      meta("turn_context"), // 4
      compacted(1), // 5
      ...afterCompaction, // 6-9
      say("user", "<environment_context>\n</environment_context>"), // 10
      say("user", "after the compaction"), // 11
      meta("turn_context"), // 12
      say("assistant", "a new answer"), // 13
      meta("event_msg", "token_count"), // 14
      meta("turn_context"), // 15
    ]);

    const window = await readWindow(rollout);

    expect(window.messages).toEqual([
      { role: "user", content: "after the compaction" },
      {
        role: "assistant",
        content: [{ type: "text", text: "a new answer" }],
      },
    ]);
    // Trailing metadata does not move it.
    expect(window.lastMessageOffset).toBe(13);
    // The line after the compacted record.
    expect(window.firstOffset).toBe(6);
  });

  test("converts exactly what readDelta converts from the line after the boundary", async () => {
    const lines = [
      say("user", "first window"),
      compacted(1),
      ...afterCompaction,
      say("user", "second window"),
      say("assistant", "reply"),
    ];
    const rollout = await writeRollout("window-parity.jsonl", lines);

    const window = await readWindow(rollout);
    const delta = await readDelta(rollout, 2);

    expect(window.messages).toEqual(delta.messages);
  });

  test("with no compacted record the window is the whole rollout", async () => {
    const window = await readWindow(FIXTURE);
    const whole = await readDelta(FIXTURE, 0);

    expect(window.messages).toEqual(whole.messages);
    expect(window.messages).toHaveLength(9);
    expect(window.lastMessageOffset).toBeGreaterThan(0);
    expect(window.lastMessageOffset).toBeLessThanOrEqual(27);
    expect(window.firstOffset).toBe(1);
  });

  test("with several compactions only what follows the last counts", async () => {
    const rollout = await writeRollout("window-many.jsonl", [
      say("user", "window one"), // 1
      compacted(1), // 2
      ...afterCompaction, // 3-6
      say("user", "window two"), // 7
      compacted(2), // 8
      ...afterCompaction, // 9-12
      say("user", "window three"), // 13
      meta("turn_context"), // 14
    ]);

    const window = await readWindow(rollout);

    expect(window.messages).toEqual([
      { role: "user", content: "window three" },
    ]);
    expect(window.lastMessageOffset).toBe(13);
    expect(window.firstOffset).toBe(9);
  });

  test("a window of only metadata since the compaction is empty with offset 0", async () => {
    const rollout = await writeRollout("window-empty.jsonl", [
      say("user", "before"),
      compacted(1),
      ...afterCompaction,
    ]);

    const window = await readWindow(rollout);

    expect(window.messages).toEqual([]);
    expect(window.lastMessageOffset).toBe(0);
    expect(window.firstOffset).toBe(3);
  });
});

describe("readDelta is unchanged by compaction records", () => {
  test("a compacted line is skipped and newOffset still counts every line", async () => {
    const rollout = await writeRollout("delta-compacted.jsonl", [
      say("user", "before"),
      compacted(1),
      ...afterCompaction,
      say("user", "after"),
    ]);

    const { messages, newOffset } = await readDelta(rollout, 0);

    expect(messages).toEqual([
      { role: "user", content: "before" },
      { role: "user", content: "after" },
    ]);
    expect(newOffset).toBe(7);
  });
});
