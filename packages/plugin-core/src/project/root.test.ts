/**
 * Tests for resolveProjectRoot against real temp directories.
 *
 * Paths are compared after realpath on both sides: macOS tmpdir lives under
 * /var, a symlink to /private/var, and git reports the resolved form.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectRoot } from "./root";

let dir = "";

const runGit = async (cwd: string, args: readonly string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
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
});
