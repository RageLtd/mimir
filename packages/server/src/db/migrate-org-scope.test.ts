import { describe, expect, test } from "bun:test";
import {
  buildBackfillSql,
  buildReassignChildSql,
  buildSentinelRemapSql,
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
    expect(buildSentinelRemapSql("project")).toBe(
      "UPDATE project SET org_id = $owner WHERE org_id = $sentinel;",
    );
  });

  test("reassign moves a history child onto the canonical project", () => {
    expect(buildReassignChildSql("memory")).toBe(
      "UPDATE memory SET project_id = $canonical WHERE project_id = $dup;",
    );
  });
});

describe("table sets", () => {
  test("all three tenant tables are org-scoped (cart_* left with MIM-91)", () => {
    expect(new Set<string>(ORG_SCOPED_TABLES)).toEqual(
      new Set(["memory", "project", "relates_to"]),
    );
  });

  test("history survives project merges (reassigned)", () => {
    expect([...REASSIGN_CHILD_TABLES]).toEqual(["memory"]);
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
