import { describe, expect, test } from "bun:test";
import {
  buildBackfillSql,
  buildDeleteChildSql,
  buildReassignChildSql,
  buildSentinelRemapSql,
  DELETE_CHILD_TABLES,
  ORG_SCOPED_TABLES,
  planProjectMerges,
  type ProjectDedupeRow,
  REASSIGN_CHILD_TABLES,
} from "./migrate-org-scope";

describe("SQL builders", () => {
  test("backfill parks unscoped rows on the owner org", () => {
    expect(buildBackfillSql("memory")).toBe(
      "UPDATE memory SET org_id = $owner WHERE org_id = NONE;",
    );
  });

  test("sentinel remap moves parked rows onto the real owner id", () => {
    expect(buildSentinelRemapSql("cart_file")).toBe(
      "UPDATE cart_file SET org_id = $owner WHERE org_id = $sentinel;",
    );
  });

  test("reassign moves a history child onto the canonical project", () => {
    expect(buildReassignChildSql("memory")).toBe(
      "UPDATE memory SET project_id = $canonical WHERE project_id = $dup;",
    );
  });

  test("delete drops a regenerable index child of a duplicate", () => {
    expect(buildDeleteChildSql("cart_import")).toBe(
      "DELETE cart_import WHERE project_id = $dup;",
    );
  });
});

describe("table sets", () => {
  test("all six tenant tables are org-scoped", () => {
    expect(new Set<string>(ORG_SCOPED_TABLES)).toEqual(
      new Set([
        "cart_file",
        "cart_git_state",
        "cart_import",
        "memory",
        "project",
        "relates_to",
      ]),
    );
  });

  test("reassign and delete child tables are disjoint", () => {
    const del = new Set<string>(DELETE_CHILD_TABLES);
    const overlap = [...REASSIGN_CHILD_TABLES].filter((t) => del.has(t));
    expect(overlap).toEqual([]);
  });

  test("history survives (reassigned), index rows are dropped", () => {
    expect([...REASSIGN_CHILD_TABLES]).toEqual(["memory"]);
    expect([...DELETE_CHILD_TABLES]).toEqual([
      "cart_file",
      "cart_import",
      "cart_git_state",
    ]);
  });
});

describe("planProjectMerges", () => {
  const row = (
    id: string,
    git_remote: string,
    updated_at: string,
  ): ProjectDedupeRow => ({ id, git_remote, updated_at });

  test("no duplicates yields no plans", () => {
    const plans = planProjectMerges([
      row("a", "RageLtd/mimir", "2026-01-01T00:00:00Z"),
      row("b", "RageLtd/other", "2026-01-01T00:00:00Z"),
    ]);
    expect(plans).toEqual([]);
  });

  test("newest updated_at becomes canonical, the rest are duplicates", () => {
    const plans = planProjectMerges([
      row("stale", "RageLtd/mimir", "2026-01-01T00:00:00Z"),
      row("fresh", "RageLtd/mimir", "2026-06-01T00:00:00Z"),
    ]);
    expect(plans).toEqual([
      { git_remote: "RageLtd/mimir", canonicalId: "fresh", dupIds: ["stale"] },
    ]);
  });

  test("collapses three records onto one canonical", () => {
    const plans = planProjectMerges([
      row("a", "RageLtd/mimir", "2026-01-01T00:00:00Z"),
      row("b", "RageLtd/mimir", "2026-03-01T00:00:00Z"),
      row("c", "RageLtd/mimir", "2026-02-01T00:00:00Z"),
    ]);
    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan?.canonicalId).toBe("b");
    expect([...(plan?.dupIds ?? [])].sort()).toEqual(["a", "c"]);
  });

  test("equal timestamps break deterministically by id (idempotent)", () => {
    const rows = [
      row("y", "RageLtd/mimir", "2026-01-01T00:00:00Z"),
      row("x", "RageLtd/mimir", "2026-01-01T00:00:00Z"),
    ];
    const first = planProjectMerges(rows);
    const second = planProjectMerges([...rows].reverse());
    expect(first).toEqual(second);
    // Higher id wins the tiebreak — stable across input order.
    expect(first[0]?.canonicalId).toBe("y");
    expect(first[0]?.dupIds).toEqual(["x"]);
  });

  test("independent remotes produce independent plans", () => {
    const plans = planProjectMerges([
      row("a1", "RageLtd/mimir", "2026-01-01T00:00:00Z"),
      row("a2", "RageLtd/mimir", "2026-02-01T00:00:00Z"),
      row("b1", "RageLtd/evals", "2026-01-01T00:00:00Z"),
      row("b2", "RageLtd/evals", "2026-02-01T00:00:00Z"),
    ]);
    expect(plans).toHaveLength(2);
    const byRemote = new Map(plans.map((p) => [p.git_remote, p]));
    expect(byRemote.get("RageLtd/mimir")?.canonicalId).toBe("a2");
    expect(byRemote.get("RageLtd/evals")?.canonicalId).toBe("b2");
  });
});
