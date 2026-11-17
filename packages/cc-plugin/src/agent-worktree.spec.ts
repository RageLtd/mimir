/**
 * Which directory a subagent's tool call works in. Claude Code runs a
 * worktree-isolated subagent in `<top level of the session's work
 * tree>/.claude/worktrees/agent-<agent id>`, but the payload's `cwd` is
 * the session's directory — so the binary finds the worktree itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentCwd } from "./agent-worktree";

const AGENT = "a0123456789abcdef";
const OTHER_AGENT = "afedcba9876543210";

let dir: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

const worktreeOf = (agentId: string) =>
  join(repo, ".claude", "worktrees", `agent-${agentId}`);

const addWorktree = (agentId: string) => {
  git(
    repo,
    "worktree",
    "add",
    "-q",
    "-b",
    `wt-${agentId}`,
    worktreeOf(agentId),
  );
  return worktreeOf(agentId);
};

beforeEach(() => {
  // Canonical from the start: git reports real paths (macOS /var → /private/var).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-agent-wt-")));
  repo = join(dir, "repo");
  git(dir, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "commit", "-q", "--allow-empty", "-m", "baseline");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveAgentCwd", () => {
  test("a subagent's call from the work tree's top level works in its worktree", async () => {
    const worktree = addWorktree(AGENT);
    expect(await resolveAgentCwd(repo, AGENT)).toEqual({
      cwd: worktree,
      missing: null,
    });
  });

  test("from a directory inside the work tree, the worktree is still found at the top level", async () => {
    const worktree = addWorktree(AGENT);
    const nested = join(repo, "packages", "deep");
    mkdirSync(nested, { recursive: true });
    expect(await resolveAgentCwd(nested, AGENT)).toEqual({
      cwd: worktree,
      missing: null,
    });
  });

  test("a cwd that already is the worktree is kept", async () => {
    const worktree = addWorktree(AGENT);
    expect(await resolveAgentCwd(worktree, AGENT)).toEqual({
      cwd: worktree,
      missing: null,
    });
  });

  test("a cwd inside the worktree is kept as given", async () => {
    const worktree = addWorktree(AGENT);
    const inside = join(worktree, "src");
    mkdirSync(inside, { recursive: true });
    expect(await resolveAgentCwd(inside, AGENT)).toEqual({
      cwd: inside,
      missing: null,
    });
  });

  test("no worktree for the agent: cwd stands and the path looked for is reported", async () => {
    expect(await resolveAgentCwd(repo, AGENT)).toEqual({
      cwd: repo,
      missing: worktreeOf(AGENT),
    });
  });

  test("another agent's worktree is never borrowed", async () => {
    addWorktree(OTHER_AGENT);
    expect(await resolveAgentCwd(repo, AGENT)).toEqual({
      cwd: repo,
      missing: worktreeOf(AGENT),
    });
  });

  test("no agent id: cwd is untouched and nothing is missing, even beside worktrees", async () => {
    addWorktree(AGENT);
    expect(await resolveAgentCwd(repo, undefined)).toEqual({
      cwd: repo,
      missing: null,
    });
  });
});
