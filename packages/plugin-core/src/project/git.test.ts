/**
 * Tests for detectGitRemote against a real temp git repo.
 *
 * Spawning git is the whole point — mocking it would test nothing useful.
 * Each test creates a fresh temp dir, initialises git, sets a remote (or
 * doesn't), and asserts the trimmed result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectGitRemote } from "./git";

let repo = "";

const runGit = async (cwd: string, args: readonly string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "mimir-git-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("detectGitRemote", () => {
  test("returns null when the directory is not a git repo", async () => {
    expect(await detectGitRemote(repo)).toBeNull();
  });

  test("returns null when the repo has no origin remote", async () => {
    await runGit(repo, ["init", "-q"]);
    expect(await detectGitRemote(repo)).toBeNull();
  });

  test("returns the trimmed remote URL when origin is configured", async () => {
    await runGit(repo, ["init", "-q"]);
    await runGit(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/org/repo.git",
    ]);
    expect(await detectGitRemote(repo)).toBe("https://github.com/org/repo");
  });

  test("strips trailing slash as well as trailing .git", async () => {
    await runGit(repo, ["init", "-q"]);
    await runGit(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/org/repo/",
    ]);
    expect(await detectGitRemote(repo)).toBe("https://github.com/org/repo");
  });

  test("preserves SSH-form remotes verbatim (minus .git)", async () => {
    await runGit(repo, ["init", "-q"]);
    await runGit(repo, [
      "remote",
      "add",
      "origin",
      "git@github.com:org/repo.git",
    ]);
    expect(await detectGitRemote(repo)).toBe("git@github.com:org/repo");
  });
});
