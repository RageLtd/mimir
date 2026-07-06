import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { OrgScope } from "../db/scope";
import { resolveProjectForQuery } from "./resolve-for-query";

// Resolution now runs on scope.db.query (via scopedQueryFirst) and the
// auto-detect path also queries scope.db directly. A hand-built OrgScope
// whose db.query is a mock lets us drive both without a real SurrealDB.
// The logger is mocked globally by tests/setup.ts (bunfig preload).

const ORG = "test-org";
const mockAutoDetect: Array<{ project_id: string; count: number }> = [];
let queryMock: ReturnType<typeof mock>;

const scope = (): OrgScope => ({
  orgId: ORG,
  db: { query: queryMock } as unknown as Surreal,
  isRoot: true,
});

describe("resolveProjectForQuery", () => {
  beforeEach(() => {
    mockAutoDetect.length = 0;
    // Default impl returns the auto-detect envelope `[rows]`. Input tests
    // override per-call with the scopedQueryFirst envelope `[[row]]`.
    queryMock = mock(() => Promise.resolve([mockAutoDetect]));
  });

  test("resolves by project record ID (first priority)", async () => {
    queryMock.mockResolvedValueOnce([[{ id: "abc123" }]]);

    const result = await resolveProjectForQuery(scope(), "abc123");

    expect(result.project).toBe("abc123");
    expect(result.error).toBeNull();
    // Should have been called once (ID lookup) and short-circuited.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test("resolves by git remote when ID lookup misses", async () => {
    // ID lookup returns no row
    queryMock.mockResolvedValueOnce([[]]);
    // Git remote lookup returns a match
    queryMock.mockResolvedValueOnce([[{ id: "proj-uuid-1" }]]);

    const result = await resolveProjectForQuery(
      scope(),
      "git@github.com:user/repo.git",
    );

    expect(result.project).toBe("proj-uuid-1");
    expect(result.error).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  test("resolves by filesystem path when ID and remote miss", async () => {
    // ID lookup returns no row
    queryMock.mockResolvedValueOnce([[]]);
    // Git remote lookup returns no row
    queryMock.mockResolvedValueOnce([[]]);
    // Path lookup returns a match
    queryMock.mockResolvedValueOnce([[{ id: "proj-uuid-2" }]]);

    const result = await resolveProjectForQuery(scope(), "/Users/dev/my-project");

    expect(result.project).toBe("proj-uuid-2");
    expect(result.error).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  test("falls back to raw input when no project table match", async () => {
    queryMock.mockResolvedValue([[]]);

    const result = await resolveProjectForQuery(scope(), "/legacy/path");

    expect(result.project).toBe("/legacy/path");
    expect(result.error).toBeNull();
    // All three lookups attempted
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  test("strips project: prefix from RecordId results", async () => {
    queryMock.mockResolvedValueOnce([[{ id: "project:xyz789" }]]);

    const result = await resolveProjectForQuery(scope(), "xyz789");

    expect(result.project).toBe("xyz789");
    expect(result.error).toBeNull();
  });

  test("auto-detects single project when input omitted", async () => {
    mockAutoDetect.push({ project_id: "only-project", count: 42 });

    const result = await resolveProjectForQuery(scope());

    expect(result.project).toBe("only-project");
    expect(result.error).toBeNull();
  });

  test("errors on multiple projects when input omitted", async () => {
    mockAutoDetect.push(
      { project_id: "proj-a", count: 10 },
      { project_id: "proj-b", count: 20 },
    );

    const result = await resolveProjectForQuery(scope());

    expect(result.project).toBe("");
    expect(result.error).toContain("Multiple projects");
    expect(result.error).toContain("proj-a");
    expect(result.error).toContain("proj-b");
  });

  test("errors when no projects indexed and input omitted", async () => {
    // mockAutoDetect is already empty

    const result = await resolveProjectForQuery(scope());

    expect(result.project).toBe("");
    expect(result.error).toContain("No projects indexed");
  });

  test("handles DB errors gracefully — falls through to next lookup", async () => {
    // ID lookup throws
    queryMock.mockRejectedValueOnce(new Error("db timeout"));
    // Git remote lookup succeeds
    queryMock.mockResolvedValueOnce([[{ id: "fallback-proj" }]]);

    const result = await resolveProjectForQuery(scope(), "some-input");

    expect(result.project).toBe("fallback-proj");
    expect(result.error).toBeNull();
  });

  test("returns raw input when all DB lookups fail", async () => {
    queryMock.mockRejectedValue(new Error("db down"));

    const result = await resolveProjectForQuery(scope(), "anything");

    expect(result.project).toBe("anything");
    expect(result.error).toBeNull();
  });
});
