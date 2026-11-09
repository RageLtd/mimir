/**
 * Tests for getOrResolveProjectId — identity keys on the repository root.
 *
 * Hosts hand hooks a cwd that drifts with Bash `cd` (MIM-131). Identity
 * must not follow it: a nested cwd and the root yield one id, the cache is
 * written under the root, and an id a no-remote repo already persisted
 * under a subdirectory path migrates through the existing alias machinery.
 *
 * MIMIR_HOME and MIMIR_ORG_REPLICA_DB point at a temp dir per test; see
 * cache.test.ts for why HOME itself is never swapped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createOrgReplica } from "../store/org-replica";
import {
  getCachedProjectId,
  getOrResolveProjectId,
  readProjectIdAliases,
  resolveProjectForPath,
  setCachedProjectId,
} from "./index";

let tmp = "";
let repo = "";
let nested = "";
const originalEnv = {
  MIMIR_HOME: process.env.MIMIR_HOME,
  MIMIR_ORG_REPLICA_DB: process.env.MIMIR_ORG_REPLICA_DB,
};

const SERVER_URL = "http://unused.invalid";
const REMOTE = "git@github.com:acme/widgets.git";

const runGit = async (cwd: string, args: readonly string[]) => {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...env } = process.env;
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...env, GIT_CEILING_DIRECTORIES: dirname(repo) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${code} in ${cwd}`);
  }
};

const pathDerivedId = async (path: string) =>
  (await resolveProjectForPath(SERVER_URL, undefined, path, null)).id;

const restoreEnv = (key: keyof typeof originalEnv) => {
  const value = originalEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mimir-identity-"));
  process.env.MIMIR_HOME = join(tmp, "home");
  process.env.MIMIR_ORG_REPLICA_DB = join(tmp, "replica.sqlite");
  repo = join(tmp, "repo");
  nested = join(repo, "packages", "core");
  await mkdir(nested, { recursive: true });
  await runGit(repo, ["init", "-q"]);
});

afterEach(async () => {
  restoreEnv("MIMIR_HOME");
  restoreEnv("MIMIR_ORG_REPLICA_DB");
  await rm(tmp, { recursive: true, force: true });
});

describe("getOrResolveProjectId", () => {
  test("a nested cwd and the repository root yield one path-derived id", async () => {
    const fromNested = await getOrResolveProjectId(SERVER_URL, nested);
    const fromRoot = await getOrResolveProjectId(SERVER_URL, repo);

    expect(fromNested).toBe(fromRoot);
    expect(fromNested).toBe(await pathDerivedId(repo));
  });

  test("caches under the root, not the cwd it was handed", async () => {
    const id = await getOrResolveProjectId(SERVER_URL, nested);

    expect(await getCachedProjectId(repo)).toBe(id);
    expect(await getCachedProjectId(nested)).toBeNull();
  });

  test("a remote-bearing repo resolves the same remote id from a nested cwd", async () => {
    await runGit(repo, ["remote", "add", "origin", REMOTE]);
    const expected = (
      await resolveProjectForPath(SERVER_URL, undefined, repo, REMOTE)
    ).id;

    expect(await getOrResolveProjectId(SERVER_URL, nested)).toBe(expected);
    expect(await getOrResolveProjectId(SERVER_URL, repo)).toBe(expected);
  });

  test("migrates an id previously cached under the nested path", async () => {
    const stale = await pathDerivedId(nested);
    await setCachedProjectId(nested, stale);
    const seeded = createOrgReplica(join(tmp, "replica.sqlite"));
    const memoryId = seeded.storeMemory({
      content: "persisted from a subdirectory",
      project_id: stale,
    });
    seeded.close();

    const id = await getOrResolveProjectId(SERVER_URL, nested);

    expect(id).toBe(await pathDerivedId(repo));
    expect(id).not.toBe(stale);
    expect((await readProjectIdAliases())[stale]).toBe(id);
    const replica = createOrgReplica(join(tmp, "replica.sqlite"));
    const migrated = replica.getMemory(memoryId);
    replica.close();
    expect(migrated?.project_id).toBe(id);
    expect(await getCachedProjectId(nested)).toBeNull();
    expect(await getCachedProjectId(repo)).toBe(id);
  });

  test("a warm root entry does not strand a stale nested entry", async () => {
    const rootId = await getOrResolveProjectId(SERVER_URL, repo);
    const stale = await pathDerivedId(nested);
    await setCachedProjectId(nested, stale);

    expect(await getOrResolveProjectId(SERVER_URL, nested)).toBe(rootId);

    expect((await readProjectIdAliases())[stale]).toBe(rootId);
    expect(await getCachedProjectId(nested)).toBeNull();
  });

  test("a directory outside any repository derives its id from itself", async () => {
    const loose = join(tmp, "loose");
    await mkdir(loose);

    expect(await getOrResolveProjectId(SERVER_URL, loose)).toBe(
      await pathDerivedId(loose),
    );
  });
});
