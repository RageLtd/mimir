import { describe, expect, test } from "bun:test";
import {
  pairKey,
  routePair,
  selectContradictionPairs,
} from "./contradict-pairs";

const opts = {
  mergeDistance: 0.18,
  contradictionDistance: 0.3,
};

describe("selectContradictionPairs", () => {
  test("keeps a pair inside the contradiction band", () => {
    const pairs = selectContradictionPairs(
      [{ a: "memory:1", b: "memory:2", distance: 0.25 }],
      opts,
    );
    expect(pairs).toEqual([{ a: "memory:1", b: "memory:2", distance: 0.25 }]);
  });

  test("excludes pairs at or below mergeDistance (consolidation's job)", () => {
    const pairs = selectContradictionPairs(
      [
        { a: "memory:1", b: "memory:2", distance: 0.18 },
        { a: "memory:3", b: "memory:4", distance: 0.1 },
      ],
      opts,
    );
    expect(pairs).toEqual([]);
  });

  test("excludes pairs beyond contradictionDistance", () => {
    const pairs = selectContradictionPairs(
      [{ a: "memory:1", b: "memory:2", distance: 0.31 }],
      opts,
    );
    expect(pairs).toEqual([]);
  });

  test("collapses (a,b) and (b,a) into one undirected pair, keeping the tightest distance", () => {
    const pairs = selectContradictionPairs(
      [
        { a: "memory:2", b: "memory:1", distance: 0.28 },
        { a: "memory:1", b: "memory:2", distance: 0.22 },
      ],
      opts,
    );
    expect(pairs).toEqual([{ a: "memory:1", b: "memory:2", distance: 0.22 }]);
  });

  test("skips pairs that already carry a supersedes edge", () => {
    const pairs = selectContradictionPairs(
      [
        { a: "memory:1", b: "memory:2", distance: 0.25 },
        { a: "memory:3", b: "memory:4", distance: 0.26 },
      ],
      { ...opts, alreadySuperseded: new Set([pairKey("memory:2", "memory:1")]) },
    );
    expect(pairs.map((p) => pairKey(p.a, p.b))).toEqual([
      pairKey("memory:3", "memory:4"),
    ]);
  });

  test("sorts tightest-first", () => {
    const pairs = selectContradictionPairs(
      [
        { a: "memory:1", b: "memory:2", distance: 0.29 },
        { a: "memory:3", b: "memory:4", distance: 0.2 },
        { a: "memory:5", b: "memory:6", distance: 0.25 },
      ],
      opts,
    );
    expect(pairs.map((p) => p.distance)).toEqual([0.2, 0.25, 0.29]);
  });

  test("returns every in-band pair (the caller applies the check budget)", () => {
    const edges = Array.from({ length: 10 }, (_, i) => ({
      a: `memory:a${i}`,
      b: `memory:b${i}`,
      distance: 0.2 + i * 0.01,
    }));
    const pairs = selectContradictionPairs(edges, opts);
    expect(pairs).toHaveLength(10);
    expect(pairs[0]?.distance).toBe(0.2);
  });

  test("ignores self-edges", () => {
    const pairs = selectContradictionPairs(
      [{ a: "memory:1", b: "memory:1", distance: 0.25 }],
      opts,
    );
    expect(pairs).toEqual([]);
  });
});

describe("routePair", () => {
  const pair = { a: "memory:1", b: "memory:2", distance: 0.25 };

  test("merge routes to the merge path (no winner/loser needed)", () => {
    expect(routePair(pair, { action: "merge", survivor: null })).toEqual({
      kind: "merge",
    });
  });

  test("demote with survivor 1 keeps a, demotes b", () => {
    expect(routePair(pair, { action: "demote", survivor: 1 })).toEqual({
      kind: "demote",
      winnerId: "memory:1",
      loserId: "memory:2",
    });
  });

  test("demote with survivor 2 keeps b, demotes a", () => {
    expect(routePair(pair, { action: "demote", survivor: 2 })).toEqual({
      kind: "demote",
      winnerId: "memory:2",
      loserId: "memory:1",
    });
  });

  test("demote with undecided survivor collapses to leave (conservative)", () => {
    expect(routePair(pair, { action: "demote", survivor: null })).toEqual({
      kind: "leave",
    });
  });

  test("leave does nothing", () => {
    expect(routePair(pair, { action: "leave", survivor: null })).toEqual({
      kind: "leave",
    });
  });
});
