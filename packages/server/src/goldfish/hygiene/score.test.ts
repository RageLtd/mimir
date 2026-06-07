import { describe, expect, test } from "bun:test";
import { scoreMemory, selectForPruning } from "./score";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed clock for deterministic tests

function daysAgo(days: number) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe("scoreMemory", () => {
  test("a fresh, high-confidence, frequently-accessed memory scores high", () => {
    const score = scoreMemory(
      {
        confidence: 1.0,
        last_accessed: daysAgo(0),
        access_count: 20,
        created_at: daysAgo(30),
      },
      NOW,
    );
    expect(score).toBeGreaterThan(0.9);
  });

  test("staleness drags the score down", () => {
    const fresh = scoreMemory(
      { confidence: 1, last_accessed: daysAgo(0), access_count: 5 },
      NOW,
    );
    const stale = scoreMemory(
      { confidence: 1, last_accessed: daysAgo(120), access_count: 5 },
      NOW,
    );
    expect(stale).toBeLessThan(fresh);
  });

  test("access count raises the score monotonically", () => {
    const rarely = scoreMemory(
      { confidence: 1, last_accessed: daysAgo(10), access_count: 0 },
      NOW,
    );
    const often = scoreMemory(
      { confidence: 1, last_accessed: daysAgo(10), access_count: 50 },
      NOW,
    );
    expect(often).toBeGreaterThan(rarely);
  });

  test("low confidence drags the score down", () => {
    const high = scoreMemory(
      { confidence: 1.0, last_accessed: daysAgo(5), access_count: 3 },
      NOW,
    );
    const low = scoreMemory(
      { confidence: 0.3, last_accessed: daysAgo(5), access_count: 3 },
      NOW,
    );
    expect(low).toBeLessThan(high);
  });

  test("missing fields fall back to sensible defaults (confidence 1, 0 accesses)", () => {
    const score = scoreMemory({ last_accessed: daysAgo(0) }, NOW);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("selectForPruning", () => {
  const opts = {
    scoreFloor: 0.15,
    minAgeDays: 14,
    maxPrunes: 50,
    now: NOW,
  };

  test("selects an old, stale, never-accessed fact below the floor", () => {
    const result = selectForPruning(
      [
        {
          id: "memory:dead",
          content: "an ancient untouched fact",
          type: "fact",
          confidence: 0.4,
          access_count: 0,
          last_accessed: daysAgo(200),
          created_at: daysAgo(200),
        },
      ],
      opts,
    );
    expect(result.map((r) => r.id)).toEqual(["memory:dead"]);
  });

  test("never prunes a memory younger than minAgeDays, however low its score", () => {
    const result = selectForPruning(
      [
        {
          id: "memory:young",
          content: "new but low-signal",
          type: "fact",
          confidence: 0.1,
          access_count: 0,
          last_accessed: daysAgo(1),
          created_at: daysAgo(1),
        },
      ],
      opts,
    );
    expect(result).toEqual([]);
  });

  test("never prunes summaries", () => {
    const result = selectForPruning(
      [
        {
          id: "memory:summary",
          content: "a compaction summary",
          type: "summary",
          confidence: 0.1,
          access_count: 0,
          last_accessed: daysAgo(300),
          created_at: daysAgo(300),
        },
      ],
      opts,
    );
    expect(result).toEqual([]);
  });

  test("never prunes reserved playbook/skill memories", () => {
    const result = selectForPruning(
      [
        {
          id: "memory:skill",
          content: "a generated playbook",
          type: "playbook",
          confidence: 0.1,
          access_count: 0,
          last_accessed: daysAgo(300),
          created_at: daysAgo(300),
        },
      ],
      opts,
    );
    expect(result).toEqual([]);
  });

  test("leaves memories above the floor alone", () => {
    const result = selectForPruning(
      [
        {
          id: "memory:alive",
          content: "still useful",
          type: "fact",
          confidence: 1,
          access_count: 10,
          last_accessed: daysAgo(2),
          created_at: daysAgo(100),
        },
      ],
      opts,
    );
    expect(result).toEqual([]);
  });

  test("caps the number of prunes and returns the worst first", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `memory:${i}`,
      content: `dead ${i}`,
      type: "fact" as const,
      confidence: 0.3,
      access_count: 0,
      // older = staler = lower score; i=9 is the oldest/worst
      last_accessed: daysAgo(100 + i * 20),
      created_at: daysAgo(300),
    }));
    const result = selectForPruning(candidates, { ...opts, maxPrunes: 3 });
    expect(result).toHaveLength(3);
    // worst (oldest) first
    expect(result[0]?.id).toBe("memory:9");
    expect(result[0]?.score).toBeLessThanOrEqual(result[1]?.score ?? 1);
  });
});
