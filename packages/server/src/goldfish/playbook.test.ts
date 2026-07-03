import { describe, expect, test } from "bun:test";
import {
  cosineDistance,
  formatPlaybookBlock,
  isStructured,
  type PlaybookRow,
  type PlaybookWithEmbedding,
  rankByTrigger,
  scopePlaybooks,
} from "./playbook";

const row = (over: Partial<PlaybookRow> & { id: string }): PlaybookRow => ({
  name: `name-${over.id}`,
  trigger: `trigger-${over.id}`,
  content: `content-${over.id}`,
  ...over,
});

describe("isStructured", () => {
  test("requires both name and trigger", () => {
    expect(isStructured(row({ id: "a" }))).toBe(true);
    expect(isStructured({ id: "b", content: "c", name: "n" })).toBe(false);
    expect(isStructured({ id: "c", content: "c", trigger: "t" })).toBe(false);
  });
});

describe("cosineDistance", () => {
  test("identical vectors → 0", () => {
    expect(cosineDistance([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 6);
  });
  test("orthogonal vectors → 1", () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 6);
  });
  test("opposite vectors → 2", () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 6);
  });
  test("empty or mismatched-length pairs → 2 (maximally distant)", () => {
    expect(cosineDistance([], [])).toBe(2);
    expect(cosineDistance([1, 0], [1])).toBe(2);
    expect(cosineDistance([0, 0], [1, 1])).toBe(2);
  });
});

describe("scopePlaybooks", () => {
  const playbooks = [
    row({ id: "active", project: "proj-1" }),
    row({ id: "global", project: undefined }),
    row({ id: "other", project: "proj-2" }),
  ];

  test("keeps global + active project, drops other projects", () => {
    const scoped = scopePlaybooks(playbooks, "proj-1");
    expect(scoped.map((p) => p.id)).toEqual(["active", "global"]);
  });

  test("project-scoped sorts before global", () => {
    const scoped = scopePlaybooks(playbooks, "proj-1");
    expect(scoped[0]?.id).toBe("active");
    expect(scoped[1]?.id).toBe("global");
  });

  test("with no active project, only global survives", () => {
    const scoped = scopePlaybooks(playbooks, undefined);
    expect(scoped.map((p) => p.id)).toEqual(["global"]);
  });
});

describe("rankByTrigger", () => {
  const withEmb = (
    id: string,
    embedding: number[],
  ): PlaybookWithEmbedding => ({ ...row({ id }), embedding });

  test("returns only matches within the distance ceiling, closest first", () => {
    const query = [1, 0, 0];
    const playbooks = [
      withEmb("near", [0.95, 0.05, 0]),
      withEmb("mid", [0.7, 0.7, 0]),
      withEmb("far", [0, 1, 0]), // distance 1 — beyond 0.45 ceiling
    ];
    const matched = rankByTrigger(query, playbooks, {
      topK: 5,
      maxDistance: 0.45,
    });
    expect(matched.map((p) => p.id)).toEqual(["near", "mid"]);
    expect(matched[0]?.distance).toBeLessThan(matched[1]?.distance ?? 0);
  });

  test("honours the topK budget so playbooks can't flood the context", () => {
    const query = [1, 0, 0];
    const playbooks = [
      withEmb("p1", [1, 0, 0]),
      withEmb("p2", [0.99, 0.01, 0]),
      withEmb("p3", [0.98, 0.02, 0]),
    ];
    const matched = rankByTrigger(query, playbooks, { topK: 2 });
    expect(matched).toHaveLength(2);
    expect(matched.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  test("no matches → empty (a task unrelated to any trigger)", () => {
    const matched = rankByTrigger([1, 0, 0], [withEmb("x", [0, 1, 0])], {
      maxDistance: 0.45,
    });
    expect(matched).toEqual([]);
  });
});

describe("formatPlaybookBlock", () => {
  test("no index entries → null (nothing to inject)", () => {
    expect(formatPlaybookBlock([], [])).toBeNull();
  });

  test("index lists name — trigger for every entry, no bodies", () => {
    const block = formatPlaybookBlock(
      [row({ id: "a", name: "Audit env", trigger: "use when auditing" })],
      [],
    );
    expect(block).toContain("Available playbooks");
    expect(block).toContain("- Audit env — use when auditing");
    expect(block).not.toContain("content-a");
  });

  test("ambient bodies are appended, and a match appears in both sections", () => {
    const matched = row({ id: "a", name: "Audit env", trigger: "use when auditing" });
    const block = formatPlaybookBlock([matched], [matched]);
    // index line
    expect(block).toContain("- Audit env — use when auditing");
    // ambient body section
    expect(block).toContain("### Audit env");
    expect(block).toContain("content-a");
  });
});
