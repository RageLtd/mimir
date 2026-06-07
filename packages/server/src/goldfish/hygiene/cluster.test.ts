import { describe, expect, test } from "bun:test";
import { groupClusters } from "./cluster";

const opts = { mergeDistance: 0.08, maxClusterSize: 5 };

describe("groupClusters", () => {
  test("groups a close pair into one cluster", () => {
    const clusters = groupClusters(
      [{ a: "memory:1", b: "memory:2", distance: 0.04 }],
      opts,
    );
    expect(clusters).toEqual([["memory:1", "memory:2"]]);
  });

  test("ignores edges above the merge distance", () => {
    const clusters = groupClusters(
      [{ a: "memory:1", b: "memory:2", distance: 0.2 }],
      opts,
    );
    expect(clusters).toEqual([]);
  });

  test("merges transitively across close edges", () => {
    const clusters = groupClusters(
      [
        { a: "memory:a", b: "memory:b", distance: 0.03 },
        { a: "memory:b", b: "memory:c", distance: 0.05 },
      ],
      opts,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toEqual(["memory:a", "memory:b", "memory:c"]);
  });

  test("keeps disjoint clusters separate", () => {
    const clusters = groupClusters(
      [
        { a: "memory:1", b: "memory:2", distance: 0.02 },
        { a: "memory:8", b: "memory:9", distance: 0.02 },
      ],
      opts,
    );
    expect(clusters).toHaveLength(2);
  });

  test("caps a runaway component at maxClusterSize", () => {
    const edges = Array.from({ length: 9 }, (_, i) => ({
      a: "memory:hub",
      b: `memory:${i}`,
      distance: 0.01,
    }));
    const clusters = groupClusters(edges, { ...opts, maxClusterSize: 5 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(5);
  });

  test("excludes singletons (no merge to make)", () => {
    const clusters = groupClusters(
      [{ a: "memory:1", b: "memory:1", distance: 0 }],
      opts,
    );
    expect(clusters).toEqual([]);
  });
});
