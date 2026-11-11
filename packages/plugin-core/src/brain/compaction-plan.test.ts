/**
 * Compaction decisions shared by every distribution — what a compaction
 * owes and how a distill settles. Pins the plan's four outcomes against
 * the summariser's floor, and the settle table.
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  compactionOwed,
  compactionPlan,
  settleCompaction,
} from "./compaction-plan";
import { prepareSummary } from "./summarize";

const longWindow: ModelMessage[] = [
  {
    role: "user",
    content: "we spent this session moving extraction client-side ".repeat(8),
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "and the summarizer now writes summary memories locally ".repeat(
          8,
        ),
      },
    ],
  },
];

const shortWindow: ModelMessage[] = [{ role: "user", content: "hi" }];

const delta: ModelMessage[] = [
  { role: "user", content: "the newest turn since the last distill" },
];

describe("compactionPlan fixtures", () => {
  test("the long window clears the summary floor and the short one does not", () => {
    expect("skipped" in prepareSummary(longWindow)).toBe(false);
    expect("skipped" in prepareSummary(shortWindow)).toBe(true);
  });
});

describe("compactionPlan", () => {
  test("summary due over the floor, empty delta → distill with summary only", () => {
    const plan = compactionPlan({
      window: longWindow,
      delta: [],
      summaryDue: true,
      configured: true,
    });
    expect(plan).toEqual({ kind: "distill", summary: longWindow, facts: null });
  });

  test("summary due over the floor, non-empty delta → distill with both", () => {
    const plan = compactionPlan({
      window: longWindow,
      delta,
      summaryDue: true,
      configured: true,
    });
    expect(plan).toEqual({
      kind: "distill",
      summary: longWindow,
      facts: delta,
    });
  });

  test("summary due under the floor, empty delta → caught-up", () => {
    const plan = compactionPlan({
      window: shortWindow,
      delta: [],
      summaryDue: true,
      configured: true,
    });
    expect(plan).toEqual({ kind: "caught-up" });
  });

  test("summary due under the floor, non-empty delta → distill with facts only", () => {
    const plan = compactionPlan({
      window: shortWindow,
      delta,
      summaryDue: true,
      configured: true,
    });
    expect(plan).toEqual({ kind: "distill", summary: null, facts: delta });
  });

  test("summary not due over the floor, empty delta → caught-up", () => {
    const plan = compactionPlan({
      window: longWindow,
      delta: [],
      summaryDue: false,
      configured: true,
    });
    expect(plan).toEqual({ kind: "caught-up" });
  });

  test("summary not due over the floor, non-empty delta → no summary owed", () => {
    const plan = compactionPlan({
      window: longWindow,
      delta,
      summaryDue: false,
      configured: true,
    });
    expect(plan).toEqual({ kind: "distill", summary: null, facts: delta });
  });

  test("nothing owed and unconfigured → caught-up wins", () => {
    const plan = compactionPlan({
      window: shortWindow,
      delta: [],
      summaryDue: false,
      configured: false,
    });
    expect(plan).toEqual({ kind: "caught-up" });
  });

  test("summary owed and unconfigured → unconfigured", () => {
    const plan = compactionPlan({
      window: longWindow,
      delta: [],
      summaryDue: true,
      configured: false,
    });
    expect(plan).toEqual({ kind: "unconfigured" });
  });

  test("facts owed and unconfigured → unconfigured", () => {
    const plan = compactionPlan({
      window: shortWindow,
      delta,
      summaryDue: false,
      configured: false,
    });
    expect(plan).toEqual({ kind: "unconfigured" });
  });

  test("the plan carries the window and delta that were passed in", () => {
    const plan = compactionPlan({
      window: longWindow,
      delta,
      summaryDue: true,
      configured: true,
    });
    if (plan.kind !== "distill") {
      throw new Error(`expected a distill plan, got ${plan.kind}`);
    }
    expect(plan.summary).toBe(longWindow);
    expect(plan.facts).toBe(delta);
  });
});

describe("compactionOwed", () => {
  test("summary due over the floor, empty delta → summary is the window, no facts", () => {
    const owed = compactionOwed({
      window: longWindow,
      delta: [],
      summaryDue: true,
    });
    expect(owed.summary).toBe(longWindow);
    expect(owed.facts).toBeNull();
  });

  test("summary due over the floor, non-empty delta → both, as passed in", () => {
    const owed = compactionOwed({
      window: longWindow,
      delta,
      summaryDue: true,
    });
    expect(owed.summary).toBe(longWindow);
    expect(owed.facts).toBe(delta);
  });

  test("summary due under the floor, empty delta → nothing owed", () => {
    const owed = compactionOwed({
      window: shortWindow,
      delta: [],
      summaryDue: true,
    });
    expect(owed).toEqual({ summary: null, facts: null });
  });

  test("summary due under the floor, non-empty delta → facts only", () => {
    const owed = compactionOwed({
      window: shortWindow,
      delta,
      summaryDue: true,
    });
    expect(owed.summary).toBeNull();
    expect(owed.facts).toBe(delta);
  });

  test("summary not due over the floor, empty delta → nothing owed", () => {
    const owed = compactionOwed({
      window: longWindow,
      delta: [],
      summaryDue: false,
    });
    expect(owed).toEqual({ summary: null, facts: null });
  });

  test("summary not due over the floor, non-empty delta → facts only", () => {
    const owed = compactionOwed({
      window: longWindow,
      delta,
      summaryDue: false,
    });
    expect(owed.summary).toBeNull();
    expect(owed.facts).toBe(delta);
  });
});

describe("compactionPlan agrees with compactionOwed", () => {
  const emptyDelta: ModelMessage[] = [];
  const windows = [longWindow, shortWindow];
  const deltas = [emptyDelta, delta];
  const dues = [true, false];

  test("configured: caught-up exactly when nothing is owed, else distill what is owed", () => {
    for (const window of windows) {
      for (const d of deltas) {
        for (const summaryDue of dues) {
          const owed = compactionOwed({ window, delta: d, summaryDue });
          const plan = compactionPlan({
            window,
            delta: d,
            summaryDue,
            configured: true,
          });
          if (owed.summary === null && owed.facts === null) {
            expect(plan).toEqual({ kind: "caught-up" });
            continue;
          }
          if (plan.kind !== "distill") {
            throw new Error(
              `expected a distill plan for window=${window.length} delta=${d.length} summaryDue=${summaryDue}, got ${plan.kind}`,
            );
          }
          expect(plan.summary).toBe(owed.summary);
          expect(plan.facts).toBe(owed.facts);
        }
      }
    }
  });
});

describe("settleCompaction", () => {
  test("no summary attempted, no facts → advance only", () => {
    expect(settleCompaction({ summary: null, factsStored: 0 })).toEqual({
      advance: true,
      markSummarized: false,
      sync: false,
    });
  });

  test("no summary attempted, facts stored → advance and sync", () => {
    expect(settleCompaction({ summary: null, factsStored: 2 })).toEqual({
      advance: true,
      markSummarized: false,
      sync: true,
    });
  });

  test("summary stored with an id → advance, mark, sync", () => {
    expect(
      settleCompaction({ summary: { ok: true, id: "sum-1" }, factsStored: 0 }),
    ).toEqual({ advance: true, markSummarized: true, sync: true });
  });

  test("summary skipped (no id), no facts → advance only", () => {
    expect(
      settleCompaction({ summary: { ok: true, id: null }, factsStored: 0 }),
    ).toEqual({ advance: true, markSummarized: false, sync: false });
  });

  test("summary skipped (no id), facts stored → advance and sync, not marked", () => {
    expect(
      settleCompaction({ summary: { ok: true, id: null }, factsStored: 3 }),
    ).toEqual({ advance: true, markSummarized: false, sync: true });
  });

  test("summary failed, no facts → nothing", () => {
    expect(
      settleCompaction({ summary: { ok: false, id: null }, factsStored: 0 }),
    ).toEqual({ advance: false, markSummarized: false, sync: false });
  });

  test("summary failed, facts stored → still nothing", () => {
    expect(
      settleCompaction({ summary: { ok: false, id: null }, factsStored: 4 }),
    ).toEqual({ advance: false, markSummarized: false, sync: false });
  });
});
