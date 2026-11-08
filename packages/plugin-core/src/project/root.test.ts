/**
 * Tests for resolveProjectRoot against real temp directories.
 *
 * Most paths are compared after realpath on both sides: macOS tmpdir lives
 * under /var, a symlink to /private/var, and git reports the resolved form.
 * The symlinked-prefix case compares strictly — keeping the caller's path form
 * is the behaviour under test there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveProjectRoot } from "./root";

let dir = "";

// Hermetic: an exported GIT_DIR/GIT_WORK_TREE or a repository above the temp
// directory must not leak into the repository a case sets up.
const gitEnv = (cwd: string) => {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...rest } = process.env;
  return { ...rest, GIT_CEILING_DIRECTORIES: dirname(cwd) };
};

const runGit = async (cwd: string, args: readonly string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitEnv(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${code} in ${cwd}`);
  }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mimir-root-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  test("resolves a nested subdirectory to the repository root", async () => {
    await runGit(dir, ["init", "-q"]);
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });

    const root = await resolveProjectRoot(nested);

    expect(await realpath(root)).toBe(await realpath(dir));
  });

  test("returns the repository root when called from it", async () => {
    await runGit(dir, ["init", "-q"]);

    const root = await resolveProjectRoot(dir);

    expect(await realpath(root)).toBe(await realpath(dir));
  });

  test("returns the input unchanged outside a repository", async () => {
    expect(await resolveProjectRoot(dir)).toBe(dir);
  });

  test("the returned root keeps the caller's symlinked path form", async () => {
    const repo = join(dir, "repo");
    const link = join(dir, "link");
    await mkdir(join(repo, "a", "b"), { recursive: true });
    await runGit(repo, ["init", "-q"]);
    await symlink(repo, link);

    const root = await resolveProjectRoot(join(link, "a", "b"));

    expect(root).toBe(link);
  });
});
