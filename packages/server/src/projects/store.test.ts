/**
 * Project store tests — SQLite edition (MIM-88). Behavior-level against a
 * real in-memory tenant db (the Surreal-era mock/NONE-coercion concerns
 * died with Surreal): resolve lookup order + identity upgrades, id
 * verification, update clear/skip semantics, and org isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setTenantDbForTests, createTenantDb } from "../db/tenant";
import {
  ensureProjectId,
  getProject,
  resolveProject,
  updateProject,
} from "./store";

const ORG = { orgId: "test-org" };
const OTHER_ORG = { orgId: "other-org" };

beforeEach(() => {
  _setTenantDbForTests(createTenantDb(":memory:"));
});

afterEach(() => {
  _setTenantDbForTests(null);
});

describe("resolveProject", () => {
  test("returns null when neither gitRemote nor localPath is provided", async () => {
    expect(await resolveProject(ORG, {})).toBeNull();
  });

  test("creates with derived title, then resolves the same record by remote", async () => {
    const created = await resolveProject(ORG, {
      gitRemote: "git@github.com:org/cool-repo.git",
      localPath: "/tmp/cool-repo",
    });
    expect(created?.title).toBe("org/cool-repo");
    expect(created?.technologies).toEqual([]);

    const resolved = await resolveProject(ORG, {
      gitRemote: "git@github.com:org/cool-repo.git",
    });
    expect(resolved?.id).toBe(created?.id ?? "");
  });

  test("git_remote match refreshes a moved local_path", async () => {
    const created = await resolveProject(ORG, {
      gitRemote: "git@github.com:org/repo",
      localPath: "/old/checkout",
    });
    const moved = await resolveProject(ORG, {
      gitRemote: "git@github.com:org/repo",
      localPath: "/new/checkout",
    });
    expect(moved?.id).toBe(created?.id ?? "");
    expect(moved?.local_path).toBe("/new/checkout");
  });

  test("local_path match upgrades identity when a remote appears", async () => {
    const created = await resolveProject(ORG, { localPath: "/tmp/greenfield" });
    expect(created?.git_remote).toBeNull();
    const upgraded = await resolveProject(ORG, {
      localPath: "/tmp/greenfield",
      gitRemote: "git@github.com:org/greenfield",
    });
    expect(upgraded?.id).toBe(created?.id ?? "");
    expect(upgraded?.git_remote).toBe("git@github.com:org/greenfield");
  });

  test("optional fields persist on create", async () => {
    const created = await resolveProject(ORG, {
      localPath: "/tmp/described",
      description: "A cool app",
      purpose: "experimental",
      technologies: ["bun", "typescript"],
    });
    expect(created?.description).toBe("A cool app");
    expect(created?.purpose).toBe("experimental");
    expect(created?.technologies).toEqual(["bun", "typescript"]);
  });
});

describe("ensureProjectId", () => {
  test("verifies a canonical id, buckets a bare name, resolves a path", async () => {
    const created = await resolveProject(ORG, { localPath: "/tmp/known" });
    if (!created) throw new Error("create failed");
    expect(await ensureProjectId(ORG, created.id)).toBe(created.id);
    // Path form get-or-creates.
    expect(await ensureProjectId(ORG, "/tmp/known")).toBe(created.id);
    // Bare bucket name becomes its own stable pseudo-path project.
    const bucket = await ensureProjectId(ORG, "default");
    expect(bucket).toBeTruthy();
    expect(await ensureProjectId(ORG, "default")).toBe(bucket);
  });
});

describe("updateProject", () => {
  test("null clears nullable fields; undefined preserves them", async () => {
    const created = await resolveProject(ORG, {
      localPath: "/tmp/mutable",
      description: "original",
      purpose: "original purpose",
    });
    if (!created) throw new Error("create failed");

    const renamed = await updateProject(ORG, created.id, { title: "renamed" });
    expect(renamed?.title).toBe("renamed");
    expect(renamed?.description).toBe("original"); // undefined → preserved

    const cleared = await updateProject(ORG, created.id, {
      description: null,
      technologies: ["rust"],
    });
    expect(cleared?.description).toBeNull();
    expect(cleared?.purpose).toBe("original purpose");
    expect(cleared?.technologies).toEqual(["rust"]);
  });

  test("unknown id returns null", async () => {
    expect(await updateProject(ORG, "nope", { title: "x" })).toBeNull();
  });
});

describe("org isolation", () => {
  test("projects never bleed across orgs", async () => {
    const mine = await resolveProject(ORG, {
      gitRemote: "git@github.com:org/shared-name",
    });
    if (!mine) throw new Error("create failed");
    // Other org resolving the same remote gets its OWN record.
    const theirs = await resolveProject(OTHER_ORG, {
      gitRemote: "git@github.com:org/shared-name",
    });
    expect(theirs?.id).not.toBe(mine.id);
    // Cross-org reads and writes miss.
    expect(await getProject(OTHER_ORG, mine.id)).toBeNull();
    expect(
      await updateProject(OTHER_ORG, mine.id, { title: "pwned" }),
    ).toBeNull();
    expect((await getProject(ORG, mine.id))?.title).not.toBe("pwned");
  });
});
