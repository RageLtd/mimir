/**
 * Tests for the project store — focused on the CREATE-shape regression.
 *
 * The May 2026 bug: resolveProject's CREATE payload sent `description: null`
 * for any unset optional field. SurrealDB's `option<string>` schema rejects
 * literal `null` ("Expected 'none | string' but found 'NULL'"), so every
 * resolve call from a Slice-2 plugin (which only sends gitRemote+localPath)
 * failed with a 500 and the plugin fell back to projectId: null on every
 * downstream call. Fix: build the CONTENT payload conditionally so
 * unset option<string> fields are absent rather than null.
 *
 * Mock-based pattern matches message-log.test.ts — a hand-built OrgScope
 * whose `db.query` is a mock intercepts the DB calls (reads and writes now
 * run on scope.db via scopedQueryFirst) so we can assert on the query
 * parameters without standing up a real SurrealDB.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { OrgScope } from "../db/scope";
import { resolveProject, updateProject } from "./store";

const ORG = "test-org";

describe("resolveProject", () => {
  let queryMock: ReturnType<typeof mock>;
  let lastCreateFields: Record<string, unknown> | null;

  const mkScope = (): OrgScope => ({
    orgId: ORG,
    db: { query: queryMock } as unknown as Surreal,
    isRoot: true,
  });

  beforeEach(() => {
    lastCreateFields = null;
    queryMock = mock(
      (query: string, params?: { fields?: Record<string, unknown> }) => {
        // Capture the CREATE payload for later assertions. scopedQueryFirst
        // unwraps SurrealDB's [[row]] envelope, so return the row nested.
        if (query.includes("CREATE project") && params?.fields) {
          lastCreateFields = params.fields;
          return Promise.resolve([
            [
              {
                id: "project:test-id",
                title: lastCreateFields.title ?? "untitled",
                description: lastCreateFields.description ?? null,
                git_remote: lastCreateFields.git_remote ?? null,
                local_path: lastCreateFields.local_path ?? null,
                technologies: lastCreateFields.technologies ?? [],
                purpose: lastCreateFields.purpose ?? null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          ]);
        }
        // SELECT WHERE git_remote / local_path → no existing project.
        return Promise.resolve([[]]);
      },
    );
  });

  test("returns null when neither gitRemote nor localPath is provided", async () => {
    const result = await resolveProject(mkScope(), {});
    expect(result).toBeNull();
  });

  test("CREATE payload omits unset optional fields rather than sending null", async () => {
    await resolveProject(mkScope(), {
      gitRemote: "git@github.com:org/repo",
      localPath: "/tmp/repo",
    });

    expect(lastCreateFields).not.toBeNull();
    // The regression: any of these being literal null would trip the
    // SurrealDB option<string> coercion error in production.
    expect(lastCreateFields).not.toHaveProperty("description");
    expect(lastCreateFields).not.toHaveProperty("purpose");
    // Required-ish fields stay present.
    expect(lastCreateFields?.git_remote).toBe("git@github.com:org/repo");
    expect(lastCreateFields?.local_path).toBe("/tmp/repo");
    // technologies defaults to [] (schema has DEFAULT [], but explicit
    // is fine — and definitely not null).
    expect(lastCreateFields?.technologies).toEqual([]);
    // MIM-69: every CREATE stamps the caller's org so the row is scoped.
    expect(lastCreateFields?.org_id).toBe(ORG);
  });

  test("CREATE payload includes description and purpose when provided", async () => {
    await resolveProject(mkScope(), {
      gitRemote: "git@github.com:org/repo",
      localPath: "/tmp/repo",
      description: "A cool app",
      purpose: "experimental",
    });

    expect(lastCreateFields?.description).toBe("A cool app");
    expect(lastCreateFields?.purpose).toBe("experimental");
  });

  test("CREATE payload omits localPath when only gitRemote is given", async () => {
    await resolveProject(mkScope(), { gitRemote: "git@github.com:org/repo" });

    expect(lastCreateFields).not.toHaveProperty("local_path");
    expect(lastCreateFields?.git_remote).toBe("git@github.com:org/repo");
  });

  test("CREATE payload omits gitRemote when only localPath is given", async () => {
    await resolveProject(mkScope(), { localPath: "/tmp/repo" });

    expect(lastCreateFields).not.toHaveProperty("git_remote");
    expect(lastCreateFields?.local_path).toBe("/tmp/repo");
  });

  test("derives a sensible title from localPath when none is given", async () => {
    await resolveProject(mkScope(), { localPath: "/Users/x/Projects/cool-thing" });
    expect(lastCreateFields?.title).toBeTruthy();
    expect(typeof lastCreateFields?.title).toBe("string");
  });
});

describe("updateProject", () => {
  let lastQuery: string;
  let lastParams: Record<string, unknown>;
  let queryMock: ReturnType<typeof mock>;

  const mkScope = (): OrgScope => ({
    orgId: ORG,
    db: { query: queryMock } as unknown as Surreal,
    isRoot: true,
  });

  beforeEach(() => {
    lastQuery = "";
    lastParams = {};
    queryMock = mock((query: string, params: Record<string, unknown>) => {
      lastQuery = query;
      lastParams = params;
      return Promise.resolve([
        [
          {
            id: "project:test-id",
            title: "x",
            description: null,
            git_remote: null,
            local_path: null,
            technologies: [],
            purpose: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      ]);
    });
  });

  test("always sets updated_at, scopes by org, and clamps to the caller's org", async () => {
    await updateProject(mkScope(), "test-id", {});
    expect(lastQuery).toContain("updated_at = time::now()");
    // MIM-69: the UPDATE only touches rows in the caller's org.
    expect(lastQuery).toContain("WHERE org_id = $scope_org");
    expect(lastParams.scope_org).toBe(ORG);
  });

  test("description=null clears via NONE, not literal null", async () => {
    // The May 2026 bug: passing null in a SurrealDB MERGE / SET value
    // tripped "Expected 'none | string' but found 'NULL'" because
    // option<T> rejects NULL. NONE is the correct sentinel.
    await updateProject(mkScope(), "test-id", { description: null });
    expect(lastQuery).toContain("description = NONE");
    expect(lastParams).not.toHaveProperty("description");
  });

  test("description=string sets via parameter", async () => {
    await updateProject(mkScope(), "test-id", { description: "new desc" });
    expect(lastQuery).toContain("description = $description");
    expect(lastParams.description).toBe("new desc");
  });

  test("purpose=null clears via NONE, purpose=string sets via parameter", async () => {
    await updateProject(mkScope(), "test-id", { purpose: null });
    expect(lastQuery).toContain("purpose = NONE");
    expect(lastParams).not.toHaveProperty("purpose");

    await updateProject(mkScope(), "test-id", { purpose: "alpha test" });
    expect(lastQuery).toContain("purpose = $purpose");
    expect(lastParams.purpose).toBe("alpha test");
  });

  test("undefined fields are skipped entirely (no SET clause, no param)", async () => {
    await updateProject(mkScope(), "test-id", { title: "renamed" });
    expect(lastQuery).toContain("title = $title");
    expect(lastQuery).not.toContain("description");
    expect(lastQuery).not.toContain("purpose");
    expect(lastQuery).not.toContain("technologies");
    expect(lastParams.title).toBe("renamed");
    expect(lastParams).not.toHaveProperty("description");
  });

  test("technologies array is passed through verbatim", async () => {
    await updateProject(mkScope(), "test-id", {
      technologies: ["bun", "typescript"],
    });
    expect(lastQuery).toContain("technologies = $technologies");
    expect(lastParams.technologies).toEqual(["bun", "typescript"]);
  });

  test("multiple fields land in a single UPDATE statement", async () => {
    await updateProject(mkScope(), "test-id", {
      title: "renamed",
      description: "a new desc",
      purpose: null,
    });
    // One UPDATE, four SET clauses (title + description + purpose + updated_at).
    const updateCount = (lastQuery.match(/UPDATE/g) ?? []).length;
    expect(updateCount).toBe(1);
    expect(lastQuery).toContain("title = $title");
    expect(lastQuery).toContain("description = $description");
    expect(lastQuery).toContain("purpose = NONE");
    expect(lastQuery).toContain("updated_at = time::now()");
  });
});
