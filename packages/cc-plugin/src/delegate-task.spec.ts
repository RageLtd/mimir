/**
 * `mimir-cc delegate task` and the boundary it keeps: what it captures,
 * what a restart preserves, what discards it, and how a broken state file
 * is reported. Git is canned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  coordinatorStatePath,
  readCoordinatorState,
} from "@mimir/plugin-core/guard";
import { cannedGit } from "@mimir/plugin-core/verify/testing";
import { delegateSandbox, HEAD, NEXT_HEAD } from "./delegate-sandbox";

const SESSION = "sess-task-boundary";

describe("delegate task", () => {
  const { delegate, delegateWith, moveHead, repo, root } =
    delegateSandbox(SESSION);
  let planFile: string;

  const task = async () => (await readCoordinatorState(SESSION))?.task;

  beforeEach(async () => {
    planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
    expect((await delegate("start", "--plan", planFile)).code).toBe(0);
  });

  test("captures HEAD and the repository's top level as the task boundary", async () => {
    const started = await delegate("task");
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain(HEAD);
    expect(await task()).toEqual({ base: HEAD, worktree: repo() });
  });

  test("the next task captures the HEAD of that moment", async () => {
    expect((await delegate("task")).code).toBe(0);
    moveHead(NEXT_HEAD);

    expect((await delegate("task")).code).toBe(0);
    expect((await task())?.base).toBe(NEXT_HEAD);
  });

  test("starting the same plan again keeps the task boundary, even as HEAD moves on", async () => {
    expect((await delegate("task")).code).toBe(0);
    moveHead(NEXT_HEAD);

    expect((await delegate("start", "--plan", planFile)).code).toBe(0);
    expect((await task())?.base).toBe(HEAD);
  });

  test("the same plan named through a symlink keeps the task boundary", async () => {
    expect((await delegate("task")).code).toBe(0);
    const original = await readCoordinatorState(SESSION);
    const alias = join(root(), "repo-alias");
    symlinkSync(repo(), alias, "dir");

    expect(
      (await delegate("start", "--plan", join(alias, "plan.md"))).code,
    ).toBe(0);
    expect(await readCoordinatorState(SESSION)).toEqual(original);
  });

  test("starting a different plan discards the boundary", async () => {
    expect((await delegate("task")).code).toBe(0);
    const nextPlan = join(repo(), "next-plan.md");
    await Bun.write(nextPlan, "next plan\n");

    expect((await delegate("start", "--plan", nextPlan)).code).toBe(0);
    expect(await task()).toBeUndefined();
  });

  test("a plan that is not written yet still starts, with a warning, and discards the boundary", async () => {
    expect((await delegate("task")).code).toBe(0);

    const missing = await delegate(
      "start",
      "--plan",
      join(repo(), "missing-plan.md"),
    );
    expect(missing.code, missing.stderr).toBe(0);
    expect(missing.stdout).toContain("plan file not written yet");
    expect(await task()).toBeUndefined();
  });

  test("a base argument is refused and the boundary stays as it was", async () => {
    expect((await delegate("task")).code).toBe(0);
    const original = await task();

    expect((await delegate("task", "--base", "HEAD")).code).toBe(1);
    expect(await task()).toEqual(original);
  });

  test("a capture that fails clears the previous boundary and exits non-zero", async () => {
    expect((await delegate("task")).code).toBe(0);
    expect(await task()).toBeDefined();

    const failed = await delegateWith(
      cannedGit({
        "rev-parse --verify HEAD": {
          code: 128,
          stderr: "fatal: not a git repository",
        },
      }),
      "task",
    );
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("Cannot capture task base");
    expect(await task()).toBeUndefined();
  });

  test("a state file with a malformed task is reported by status, not thrown, and stop clears it", async () => {
    await Bun.write(
      coordinatorStatePath(SESSION),
      JSON.stringify({
        active: true,
        planFile,
        task: { base: 123 },
      }),
    );

    const status = await delegate("status");
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("Invalid coordinator task state");
    expect(status.stderr).not.toContain("    at ");
    expect((await delegate("stop")).code).toBe(0);
    expect((await delegate("status")).stdout).toContain("no active delegation");
  });
});
