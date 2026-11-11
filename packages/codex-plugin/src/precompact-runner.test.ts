import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { runPreCompact } from "./precompact-runner";

/** Well over the summary floor on its own. */
const LONG =
  "A substantive design discussion about the replica sync path. ".repeat(10);
const user = (content: string) =>
  ({ role: "user", content }) satisfies ModelMessage;
const SESSION = "codex-session-runner";
const INPUT = { sessionId: SESSION, transcriptPath: "/rollouts/session.jsonl" };
const PREVIOUS_ID = "memory:summary-previous";
const NEW_ID = "memory:summary-new";
const PREVIOUS_TEXT = "Earlier we moved the replica onto bun:sqlite.";

type StateFields = {
  readonly offset?: number;
  readonly summarizedThrough?: number;
  readonly summaryId?: string;
};

type World = {
  window: {
    messages: ModelMessage[];
    lastMessageOffset: number;
    firstOffset: number;
  };
  delta: { messages: ModelMessage[]; newOffset: number };
  watermark: number;
  summaryState: { summarizedThrough: number; summaryId: string | null };
  summaries: Record<string, string>;
  summarizeResult: { ok: boolean; id: string | null };
  factsStored: number;
  extraction: { baseUrl: string; model: string } | null;
  /** The dependency that rejects, if any. */
  failing: "readWindow" | "summarize" | "summaryText" | "writeState" | null;
};

const defaults = (): World => ({
  // The window starts after a compaction at line 4.
  window: {
    messages: [user(LONG), user(LONG)],
    lastMessageOffset: 9,
    firstOffset: 5,
  },
  delta: { messages: [user("a follow-up")], newOffset: 12 },
  watermark: 7,
  summaryState: { summarizedThrough: 0, summaryId: null },
  summaries: {},
  summarizeResult: { ok: true, id: NEW_ID },
  factsStored: 0,
  extraction: { baseUrl: "http://unused", model: "test" },
  failing: null,
});

/** Fakes every dependency and records each effect in call order. */
const harness = (overrides: Partial<World> = {}) => {
  const world = { ...defaults(), ...overrides };
  const events: string[] = [];
  const summarized: ModelMessage[][] = [];
  const extracted: ModelMessage[][] = [];
  const stateWrites: StateFields[] = [];
  const summaryTextReads: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const failIf = (name: World["failing"]) => {
    if (world.failing === name) throw new Error(`${name} failed`);
  };
  const deps = {
    readWindow: async (_path: string) => {
      failIf("readWindow");
      return world.window;
    },
    readDelta: async (_path: string, _watermark: number) => world.delta,
    readWatermark: async (_sessionId: string) => world.watermark,
    readSummaryState: async (_sessionId: string) => world.summaryState,
    writeState: async (_sessionId: string, fields: StateFields) => {
      events.push("writeState");
      failIf("writeState");
      stateWrites.push(fields);
    },
    summaryText: async (id: string) => {
      summaryTextReads.push(id);
      failIf("summaryText");
      return world.summaries[id] ?? null;
    },
    summarize: async (messages: readonly ModelMessage[]) => {
      events.push("summarize");
      summarized.push([...messages]);
      failIf("summarize");
      return world.summarizeResult;
    },
    extractFacts: async (messages: readonly ModelMessage[]) => {
      events.push("extractFacts");
      extracted.push([...messages]);
      return world.factsStored;
    },
    sync: async () => {
      events.push("sync");
    },
    close: () => {
      events.push("close");
    },
    extraction: world.extraction,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        warnings.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
  const run = () => runPreCompact(INPUT, deps);
  return {
    run,
    events,
    summarized,
    extracted,
    stateWrites,
    summaryTextReads,
    warnings,
    errors,
    closes: () => events.filter((event) => event === "close").length,
  };
};

const CARRIED = {
  summaryState: { summarizedThrough: 4, summaryId: PREVIOUS_ID },
  summaries: { [PREVIOUS_ID]: PREVIOUS_TEXT },
};

describe("runPreCompact — summary stored", () => {
  test("summarises the carried summary then the window, writes the state once, closes, then syncs", async () => {
    const h = harness(CARRIED);

    await h.run();

    expect(h.summarized).toHaveLength(1);
    const [first, ...rest] = h.summarized[0] ?? [];
    expect(first?.role).toBe("user");
    expect(JSON.stringify(first?.content)).toContain(PREVIOUS_TEXT);
    expect(rest).toEqual([user(LONG), user(LONG)]);

    expect(h.extracted).toEqual([[user("a follow-up")]]);
    expect(h.stateWrites).toEqual([
      { offset: 12, summarizedThrough: 9, summaryId: NEW_ID },
    ]);
    expect(h.closes()).toBe(1);
    const syncAt = h.events.indexOf("sync");
    expect(syncAt).toBeGreaterThan(h.events.indexOf("writeState"));
    expect(syncAt).toBeGreaterThan(h.events.indexOf("close"));
  });

  test("a previous summary id whose row is gone is not an error: the window is summarised alone", async () => {
    const h = harness({
      summaryState: { summarizedThrough: 4, summaryId: "memory:deleted" },
    });

    await h.run();

    expect(h.summarized).toEqual([[user(LONG), user(LONG)]]);
    expect(h.stateWrites).toEqual([
      { offset: 12, summarizedThrough: 9, summaryId: NEW_ID },
    ]);
    expect(h.events).toContain("sync");
    expect(h.closes()).toBe(1);
  });
});

describe("runPreCompact — the previous summary is carried only from an earlier window", () => {
  test("a summary of this same window (summarizedThrough at or past firstOffset) is not carried or even read", async () => {
    // A compaction aborted after the hook ran: the stored summary already
    // covers this window up to line 5, and the window has grown to line 9.
    const h = harness({
      summaryState: { summarizedThrough: 5, summaryId: PREVIOUS_ID },
      summaries: { [PREVIOUS_ID]: PREVIOUS_TEXT },
    });

    await h.run();

    expect(h.summaryTextReads).toEqual([]);
    expect(h.summarized).toEqual([[user(LONG), user(LONG)]]);
    expect(h.stateWrites).toEqual([
      { offset: 12, summarizedThrough: 9, summaryId: NEW_ID },
    ]);
  });

  test("a summary ending before firstOffset is carried", async () => {
    const h = harness(CARRIED);

    await h.run();

    expect(h.summaryTextReads).toEqual([PREVIOUS_ID]);
    expect(JSON.stringify(h.summarized[0]?.[0]?.content)).toContain(
      PREVIOUS_TEXT,
    );
  });
});

describe("runPreCompact — summary fails", () => {
  test("extracts no facts, writes nothing, does not sync, still closes", async () => {
    const h = harness({ summarizeResult: { ok: false, id: null } });

    await h.run();

    expect(h.summarized).toHaveLength(1);
    expect(h.extracted).toEqual([]);
    expect(h.stateWrites).toEqual([]);
    expect(h.events).not.toContain("sync");
    expect(h.closes()).toBe(1);
  });
});

describe("runPreCompact — summary gated out by the floor", () => {
  const small = {
    window: {
      messages: [user("first prompt")],
      lastMessageOffset: 3,
      firstOffset: 1,
    },
    delta: { messages: [user("second prompt")], newOffset: 4 },
    watermark: 2,
  };

  test("facts come from the delta, the state write carries the watermark only", async () => {
    const h = harness(small);

    await h.run();

    expect(h.summarized).toEqual([]);
    expect(h.extracted).toEqual([[user("second prompt")]]);
    expect(h.stateWrites).toEqual([{ offset: 4 }]);
    expect(h.events).not.toContain("sync");
    expect(h.closes()).toBe(1);
  });

  test("syncs when a fact was stored, after the write and the close", async () => {
    const h = harness({ ...small, factsStored: 2 });

    await h.run();

    expect(h.stateWrites).toEqual([{ offset: 4 }]);
    expect(h.closes()).toBe(1);
    const syncAt = h.events.indexOf("sync");
    expect(syncAt).toBeGreaterThan(h.events.indexOf("writeState"));
    expect(syncAt).toBeGreaterThan(h.events.indexOf("close"));
  });
});

describe("runPreCompact — caught up", () => {
  const caughtUp = {
    summaryState: { summarizedThrough: 9, summaryId: PREVIOUS_ID },
    summaries: { [PREVIOUS_ID]: PREVIOUS_TEXT },
  };

  test("nothing is summarised or extracted; a grown rollout still moves the watermark", async () => {
    const h = harness({
      ...caughtUp,
      delta: { messages: [], newOffset: 11 },
      watermark: 8,
    });

    await h.run();

    expect(h.summarized).toEqual([]);
    expect(h.extracted).toEqual([]);
    expect(h.stateWrites).toEqual([{ offset: 11 }]);
    expect(h.events).not.toContain("sync");
    expect(h.closes()).toBe(1);
  });

  test("nothing is written when the rollout has not grown past the watermark", async () => {
    const h = harness({
      ...caughtUp,
      delta: { messages: [], newOffset: 8 },
      watermark: 8,
    });

    await h.run();

    expect(h.stateWrites).toEqual([]);
    expect(h.events).toEqual(["close"]);
  });
});

describe("runPreCompact — extraction unconfigured", () => {
  test("warns once, writes the watermark only, stores nothing", async () => {
    const h = harness({ extraction: null });

    await h.run();

    expect(h.warnings).toHaveLength(1);
    expect(h.stateWrites).toEqual([{ offset: 12 }]);
    expect(h.summarized).toEqual([]);
    expect(h.extracted).toEqual([]);
    expect(h.events).not.toContain("sync");
    expect(h.closes()).toBe(1);
  });
});

describe("runPreCompact — never rejects (the hook exits 0 unconditionally)", () => {
  test("a state write that throws on the stored path: one error log, no sync, closed once", async () => {
    const h = harness({ ...CARRIED, failing: "writeState" });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.errors).toHaveLength(1);
    expect(h.events).not.toContain("sync");
    expect(h.closes()).toBe(1);
  });

  test("a state write that throws after a stored fact: one error log, no sync, closed once", async () => {
    const h = harness({
      window: {
        messages: [user("first prompt")],
        lastMessageOffset: 3,
        firstOffset: 1,
      },
      delta: { messages: [user("second prompt")], newOffset: 4 },
      watermark: 2,
      factsStored: 2,
      failing: "writeState",
    });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.errors).toHaveLength(1);
    expect(h.events).not.toContain("sync");
    expect(h.closes()).toBe(1);
  });

  test("a state write that throws on the caught-up path: one error log, closed once", async () => {
    const h = harness({
      summaryState: { summarizedThrough: 9, summaryId: PREVIOUS_ID },
      delta: { messages: [], newOffset: 11 },
      watermark: 8,
      failing: "writeState",
    });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.errors).toHaveLength(1);
    expect(h.closes()).toBe(1);
  });

  test("a state write that throws when unconfigured: one error log, closed once", async () => {
    const h = harness({ extraction: null, failing: "writeState" });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.errors).toHaveLength(1);
    expect(h.closes()).toBe(1);
  });

  for (const failing of ["summarize", "summaryText", "readWindow"] as const) {
    test(`${failing} rejecting: one error log, nothing written, no sync, closed once`, async () => {
      const h = harness({ ...CARRIED, failing });

      await expect(h.run()).resolves.toBeUndefined();

      expect(h.errors).toHaveLength(1);
      expect(h.stateWrites).toEqual([]);
      expect(h.events).not.toContain("writeState");
      expect(h.events).not.toContain("sync");
      expect(h.closes()).toBe(1);
    });
  }
});
