import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "@mimir/plugin-core/verify";
import { bootstrapWorktree, isAgentWorktree } from "./worktree-bootstrap";

let previousMimirHome: string | undefined;
let home: string;
let repo: string;

beforeAll(() => {
  previousMimirHome = process.env.MIMIR_HOME;
  home = mkdtempSync(join(tmpdir(), "mimir-bootstrap-home-"));
  mkdirSync(join(home, "agents"), { recursive: true });
  process.env.MIMIR_HOME = home;
  repo = mkdtempSync(join(tmpdir(), "mimir-bootstrap-repo-"));
});

afterAll(() => {
  if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousMimirHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const worktree = (name: string) => {
  const dir = join(repo, ".claude", "worktrees", name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const runner = (code: number, seen: string[][] = []): CommandRunner => {
  return async (argv, cwd) => {
    seen.push([...argv, cwd]);
    return { code, stdout: "", stderr: "", timedOut: false };
  };
};

describe("isAgentWorktree", () => {
  test("only paths under .claude/worktrees", () => {
    expect(isAgentWorktree("/r/.claude/worktrees/agent-1/packages/x")).toBe(
      true,
    );
    expect(isAgentWorktree("/r/packages/x")).toBe(false);
  });
});

describe("bootstrapWorktree", () => {
  test("outside an agent worktree nothing happens", async () => {
    const seen: string[][] = [];
    expect(await bootstrapWorktree(repo, runner(0, seen))).toBe(
      "not-a-worktree",
    );
    expect(seen).toEqual([]);
  });

  test("no lockfile → ready without installing", async () => {
    const wt = worktree("agent-nolock");
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("ready");
    expect(seen).toEqual([]);
  });

  test("lockfile and no node_modules → installs once, then ready", async () => {
    const wt = worktree("agent-fresh");
    await Bun.write(join(wt, "bun.lock"), "");
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("installed");
    expect(seen).toEqual([["bun", "install", "--frozen-lockfile", wt]]);
    // Second call: the marker stops a repeat even though node_modules is
    // still absent (the fake runner installed nothing).
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("ready");
    expect(seen).toHaveLength(1);
  });

  test("node_modules already present → ready, no install", async () => {
    const wt = worktree("agent-warm");
    await Bun.write(join(wt, "bun.lock"), "");
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("ready");
    expect(seen).toEqual([]);
  });

  test("a failing install reports failed and is not retried", async () => {
    const wt = worktree("agent-broken");
    await Bun.write(join(wt, "bun.lock"), "");
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(1, seen))).toBe("failed");
    expect(await bootstrapWorktree(wt, runner(1, seen))).toBe("ready");
    expect(seen).toHaveLength(1);
  });
});
