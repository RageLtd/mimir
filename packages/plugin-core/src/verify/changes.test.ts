/**
 * Change-set collection against real git repos in temp dirs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectChanges, resolveBase } from "./changes";
import { runCommand } from "./exec";

const dirs: string[] = [];

const mkTmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimir-changes-"));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]) => {
  const r = await runCommand(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const write = async (root: string, rel: string, content: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await Bun.write(join(root, rel), content);
};

/** A repo with one commit containing src/a.ts and src/a.test.ts. */
const seedRepo = async () => {
  const root = await mkTmp();
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "t");
  await write(root, "src/a.ts", "export const a = 1;\n");
  await write(
    root,
    "src/a.test.ts",
    'test("a", () => { expect(a).toBe(1); });\n',
  );
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "base");
  return root;
};

describe("resolveBase", () => {
  test("main worktree → HEAD", async () => {
    const root = await seedRepo();
    expect(await resolveBase(runCommand, root)).toBe(
      await git(root, "rev-parse", "HEAD"),
    );
  });

  test("linked worktree → merge-base with main HEAD", async () => {
    const root = await seedRepo();
    const baseSha = await git(root, "rev-parse", "HEAD");
    const wt = join(root, ".claude", "worktrees", "w1");
    await git(root, "worktree", "add", "-q", "-b", "w1", wt);
    await write(wt, "src/b.ts", "export const b = 2;\n");
    await git(wt, "add", ".");
    await git(wt, "commit", "-q", "-m", "worker commit");
    expect(await resolveBase(runCommand, wt)).toBe(baseSha);
  });

  test("not a repo → null", async () => {
    const dir = await mkTmp();
    expect(await resolveBase(runCommand, dir)).toBeNull();
  });
});

describe("collectChanges", () => {
  test("uncommitted edits, untracked files, and deletions in a worktree", async () => {
    const root = await seedRepo();
    const wt = join(root, ".claude", "worktrees", "w2");
    await git(root, "worktree", "add", "-q", "-b", "w2", wt);

    await write(wt, "src/a.ts", "export const a = 2;\n");
    await write(wt, "src/c.ts", "export const c = 3;\n");
    await rm(join(wt, "src/a.test.ts"));

    const changes = await collectChanges(runCommand, wt);
    const byPath = new Map(changes?.files.map((f) => [f.path, f]));

    const a = byPath.get("src/a.ts");
    expect(a?.status).toBe("M");
    expect(a?.added).toBe("export const a = 2;");
    expect(a?.removed).toBe("export const a = 1;");
    expect(a?.before).toBe("export const a = 1;\n");
    expect(a?.after).toBe("export const a = 2;\n");

    const c = byPath.get("src/c.ts");
    expect(c?.status).toBe("A");
    expect(c?.before).toBeNull();
    expect(c?.added).toBe("export const c = 3;\n");

    const t = byPath.get("src/a.test.ts");
    expect(t?.status).toBe("D");
    expect(t?.after).toBeNull();
  });

  test("committed worker changes count too, against the merge-base", async () => {
    const root = await seedRepo();
    const wt = join(root, ".claude", "worktrees", "w3");
    await git(root, "worktree", "add", "-q", "-b", "w3", wt);
    await write(wt, "src/d.ts", "export const d = 4;\n");
    await git(wt, "add", ".");
    await git(wt, "commit", "-q", "-m", "worker");
    const changes = await collectChanges(runCommand, wt);
    expect(changes?.files.map((f) => f.path)).toEqual(["src/d.ts"]);
  });

  test("clean worktree → empty change set", async () => {
    const root = await seedRepo();
    expect((await collectChanges(runCommand, root))?.files).toEqual([]);
  });
});

/** Trunk `main` plus an `integration` branch carrying one committed test change. */
const seedIntegrationBranch = async () => {
  const root = await seedRepo();
  await git(root, "checkout", "-q", "-b", "integration");
  await write(
    root,
    "src/a.test.ts",
    'test("a", () => { expect(a).toBe(2); });\n',
  );
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "tests (red)");
  return root;
};

describe("collectChanges branchPaths", () => {
  test("files committed on the integration branch since trunk, worker in a linked worktree", async () => {
    const root = await seedIntegrationBranch();
    const wt = join(root, ".claude", "worktrees", "w4");
    await git(root, "worktree", "add", "-q", "-b", "w4", wt);
    await write(wt, "src/a.ts", "export const a = 2;\n");

    const changes = await collectChanges(runCommand, wt);
    expect(changes?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(changes?.branchPaths).toEqual(["src/a.test.ts"]);
  });

  test("same when the worker runs in the main worktree on the integration branch", async () => {
    const root = await seedIntegrationBranch();
    await write(root, "src/a.ts", "export const a = 2;\n");

    const changes = await collectChanges(runCommand, root);
    expect(changes?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(changes?.branchPaths).toEqual(["src/a.test.ts"]);
  });

  test("empty when the base sits on trunk", async () => {
    const root = await seedRepo();
    const wt = join(root, ".claude", "worktrees", "w5");
    await git(root, "worktree", "add", "-q", "-b", "w5", wt);
    await write(wt, "src/e.ts", "export const e = 5;\n");
    expect((await collectChanges(runCommand, wt))?.branchPaths).toEqual([]);
  });

  test("empty when the repo has no trunk branch at all", async () => {
    const root = await mkTmp();
    await git(root, "init", "-q", "-b", "trunkless");
    await git(root, "config", "user.email", "t@example.com");
    await git(root, "config", "user.name", "t");
    await write(root, "src/a.ts", "export const a = 1;\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "base");
    await write(root, "src/a.ts", "export const a = 2;\n");
    expect((await collectChanges(runCommand, root))?.branchPaths).toEqual([]);
  });
});
