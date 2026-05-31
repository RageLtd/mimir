import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the DB layer before importing the module under test.
let queryFirstStub: ReturnType<typeof mock>;
let getDbStub: ReturnType<typeof mock>;

const mockQueryResult: Array<{ project: string; count: number }> = [];

mock.module("../db/surreal", () => {
  queryFirstStub = mock();
  getDbStub = mock(() =>
    Promise.resolve({
      query: mock(() => Promise.resolve([mockQueryResult])),
    }),
  );
  return {
    queryFirst: queryFirstStub,
    getDb: getDbStub,
  };
});

// Silence log output during tests.
mock.module("../util/logger", () => ({
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const { resolveProjectForQuery } = await import("./resolve-for-query");

describe("resolveProjectForQuery", () => {
  beforeEach(() => {
    queryFirstStub.mockReset();
    mockQueryResult.length = 0;
  });

  afterEach(() => {
    queryFirstStub.mockReset();
  });

  test("resolves by project record ID (first priority)", async () => {
    queryFirstStub.mockResolvedValueOnce({ id: "abc123" });

    const result = await resolveProjectForQuery("abc123");

    expect(result.project).toBe("abc123");
    expect(result.error).toBeNull();
    // Should have been called once (ID lookup) and short-circuited.
    expect(queryFirstStub).toHaveBeenCalledTimes(1);
  });

  test("resolves by git remote when ID lookup misses", async () => {
    // ID lookup returns null
    queryFirstStub.mockResolvedValueOnce(null);
    // Git remote lookup returns a match
    queryFirstStub.mockResolvedValueOnce({ id: "proj-uuid-1" });

    const result = await resolveProjectForQuery(
      "git@github.com:user/repo.git",
    );

    expect(result.project).toBe("proj-uuid-1");
    expect(result.error).toBeNull();
    expect(queryFirstStub).toHaveBeenCalledTimes(2);
  });

  test("resolves by filesystem path when ID and remote miss", async () => {
    // ID lookup returns null
    queryFirstStub.mockResolvedValueOnce(null);
    // Git remote lookup returns null
    queryFirstStub.mockResolvedValueOnce(null);
    // Path lookup returns a match
    queryFirstStub.mockResolvedValueOnce({ id: "proj-uuid-2" });

    const result = await resolveProjectForQuery("/Users/dev/my-project");

    expect(result.project).toBe("proj-uuid-2");
    expect(result.error).toBeNull();
    expect(queryFirstStub).toHaveBeenCalledTimes(3);
  });

  test("falls back to raw input when no project table match", async () => {
    queryFirstStub.mockResolvedValue(null);

    const result = await resolveProjectForQuery("/legacy/path");

    expect(result.project).toBe("/legacy/path");
    expect(result.error).toBeNull();
    // All three lookups attempted
    expect(queryFirstStub).toHaveBeenCalledTimes(3);
  });

  test("strips project: prefix from RecordId results", async () => {
    queryFirstStub.mockResolvedValueOnce({ id: "project:xyz789" });

    const result = await resolveProjectForQuery("xyz789");

    expect(result.project).toBe("xyz789");
    expect(result.error).toBeNull();
  });

  test("auto-detects single project when input omitted", async () => {
    mockQueryResult.push({ project: "only-project", count: 42 });

    const result = await resolveProjectForQuery();

    expect(result.project).toBe("only-project");
    expect(result.error).toBeNull();
  });

  test("errors on multiple projects when input omitted", async () => {
    mockQueryResult.push(
      { project: "proj-a", count: 10 },
      { project: "proj-b", count: 20 },
    );

    const result = await resolveProjectForQuery();

    expect(result.project).toBe("");
    expect(result.error).toContain("Multiple projects");
    expect(result.error).toContain("proj-a");
    expect(result.error).toContain("proj-b");
  });

  test("errors when no projects indexed and input omitted", async () => {
    // mockQueryResult is already empty

    const result = await resolveProjectForQuery();

    expect(result.project).toBe("");
    expect(result.error).toContain("No projects indexed");
  });

  test("handles DB errors gracefully — falls through to next lookup", async () => {
    // ID lookup throws
    queryFirstStub.mockRejectedValueOnce(new Error("db timeout"));
    // Git remote lookup succeeds
    queryFirstStub.mockResolvedValueOnce({ id: "fallback-proj" });

    const result = await resolveProjectForQuery("some-input");

    expect(result.project).toBe("fallback-proj");
    expect(result.error).toBeNull();
  });

  test("returns raw input when all DB lookups fail", async () => {
    queryFirstStub.mockRejectedValue(new Error("db down"));

    const result = await resolveProjectForQuery("anything");

    expect(result.project).toBe("anything");
    expect(result.error).toBeNull();
  });
});
