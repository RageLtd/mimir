import { describe, expect, test } from "bun:test";
import { prepareSummary } from "@mimir/plugin-core/brain/summarize";
import {
  precompactPlan,
  settlePrecompact,
  summaryInput,
} from "./precompact-plan";

type Message = Parameters<typeof precompactPlan>[0]["window"][number];

/** Well over the summary floor on its own. */
const LONG =
  "A substantive design discussion about the replica sync path. ".repeat(10);
const user = (content: string) => ({ role: "user", content }) satisfies Message;
const extraction = { baseUrl: "http://unused", model: "test" };

describe("precompactPlan — summary from the whole rollout, facts from the delta", () => {
  test("a tiny delta in a large window summarises the window and reads facts from the delta alone", () => {
    const delta = [user("a short follow-up")];
    const window = [user(LONG), user(LONG), ...delta];

    const plan = precompactPlan({
      window,
      delta,
      lastMessageOffset: 3,
      summarizedThrough: 0,
      extraction,
    });

    expect(plan).toEqual({ kind: "distill", summary: window, facts: delta });
  });

  test("an empty delta (the Stop hook caught up) still summarises the window, with no fact extraction", () => {
    const window = [user(LONG), user(LONG)];

    expect(
      precompactPlan({
        window,
        delta: [],
        lastMessageOffset: 2,
        summarizedThrough: 0,
        extraction,
      }),
    ).toEqual({ kind: "distill", summary: window, facts: null });
  });

  test("a window under the summary floor plans no summary; the delta's facts are still read", () => {
    const delta = [user("second prompt")];
    const window = [user("first prompt"), ...delta];

    expect(
      precompactPlan({
        window,
        delta,
        lastMessageOffset: 2,
        summarizedThrough: 0,
        extraction,
      }),
    ).toEqual({ kind: "distill", summary: null, facts: delta });
  });

  test("a window under the floor with an empty delta is caught up", () => {
    expect(
      precompactPlan({
        window: [user("first prompt")],
        delta: [],
        lastMessageOffset: 1,
        summarizedThrough: 0,
        extraction,
      }),
    ).toEqual({ kind: "caught-up" });
  });

  test("a window summarised through its end is not summarised again; new lines earn a summary", () => {
    const window = [user(LONG), user(LONG)];

    expect(
      precompactPlan({
        window,
        delta: [],
        lastMessageOffset: 2,
        summarizedThrough: 2,
        extraction,
      }),
    ).toEqual({ kind: "caught-up" });

    const grown = [...window, user("a new turn")];
    expect(
      precompactPlan({
        window: grown,
        delta: [user("a new turn")],
        lastMessageOffset: 3,
        summarizedThrough: 2,
        extraction,
      }),
    ).toEqual({
      kind: "distill",
      summary: grown,
      facts: [user("a new turn")],
    });
  });

  test("unconfigured extraction with work to do is unconfigured; with nothing to do it is caught up", () => {
    expect(
      precompactPlan({
        window: [user(LONG)],
        delta: [],
        lastMessageOffset: 1,
        summarizedThrough: 0,
        extraction: null,
      }),
    ).toEqual({ kind: "unconfigured" });
    expect(
      precompactPlan({
        window: [user(LONG)],
        delta: [],
        lastMessageOffset: 1,
        summarizedThrough: 1,
        extraction: null,
      }),
    ).toEqual({ kind: "caught-up" });
  });

  test("only metadata since the summary mark (same last message offset) plans no summary", () => {
    // Codex appended turn_context / token_count lines after the last
    // summary; the rollout grew but the conversation did not.
    expect(
      precompactPlan({
        window: [user(LONG), user(LONG)],
        delta: [],
        lastMessageOffset: 14,
        summarizedThrough: 14,
        extraction,
      }),
    ).toEqual({ kind: "caught-up" });
  });
});

describe("summaryInput — the previous summary carries the narrative across compactions", () => {
  const window = [user("since the compaction"), user("another turn")];

  test("a previous summary goes first as one user message, labelled, followed by the window", () => {
    const carried = summaryInput({
      window,
      previousSummary: "We chose bun:sqlite for the replica.",
    });

    expect(carried).toHaveLength(window.length + 1);
    expect(carried.slice(1)).toEqual(window);
    const first = carried[0];
    expect(first?.role).toBe("user");
    const text = JSON.stringify(first?.content);
    expect(text).toContain("We chose bun:sqlite for the replica.");
    expect(text).toMatch(/before the last compaction/i);
  });

  test("no previous summary leaves the window unchanged", () => {
    expect(summaryInput({ window, previousSummary: null })).toEqual(window);
    expect(summaryInput({ window, previousSummary: "" })).toEqual(window);
  });

  test("a carried summary does not make a too-small window summarisable", () => {
    const tiny = [user("first prompt")];
    // The carried input alone would clear the floor...
    expect(
      "skipped" in
        prepareSummary(summaryInput({ window: tiny, previousSummary: LONG })),
    ).toBe(false);
    // ...but the plan judges the window alone.
    expect(
      precompactPlan({
        window: tiny,
        delta: [],
        lastMessageOffset: 1,
        summarizedThrough: 0,
        extraction,
      }),
    ).toEqual({ kind: "caught-up" });
  });
});

describe("settlePrecompact — watermark, summary mark and sync after a distill", () => {
  test("a stored summary advances, marks the window summarised, and syncs", () => {
    expect(
      settlePrecompact({
        summary: { ok: true, id: "memory:summary" },
        factsStored: 0,
      }),
    ).toEqual({ advance: true, markSummarized: true, sync: true });
  });

  test("a summary gated out advances without marking; syncs only when facts landed", () => {
    expect(
      settlePrecompact({ summary: { ok: true, id: null }, factsStored: 0 }),
    ).toEqual({ advance: true, markSummarized: false, sync: false });
    expect(
      settlePrecompact({ summary: { ok: true, id: null }, factsStored: 2 }),
    ).toEqual({ advance: true, markSummarized: false, sync: true });
  });

  test("no summary planned: advances, syncs only when facts landed", () => {
    expect(settlePrecompact({ summary: null, factsStored: 0 })).toEqual({
      advance: true,
      markSummarized: false,
      sync: false,
    });
    expect(settlePrecompact({ summary: null, factsStored: 1 })).toEqual({
      advance: true,
      markSummarized: false,
      sync: true,
    });
  });

  test("a failed summary keeps the watermark, marks nothing, and does not sync", () => {
    expect(
      settlePrecompact({ summary: { ok: false, id: null }, factsStored: 0 }),
    ).toEqual({ advance: false, markSummarized: false, sync: false });
  });
});
