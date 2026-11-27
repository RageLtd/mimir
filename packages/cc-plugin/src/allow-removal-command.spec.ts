/**
 * `mimir-cc delegate allow-removal <path>...` — the test files the current
 * task may lose assertions in. The allowance lives on the task boundary,
 * beside the allowed deletions, and ends with the task. Git is canned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readCoordinatorState } from "@mimir/plugin-core/guard";
import { delegateSandbox } from "./delegate-sandbox";

const SESSION = "sess-allow-removal";
// Repository-relative test files. None is a substring of another.
const FIRST = "pkg/first.spec.ts";
const SECOND = "pkg/second.spec.ts";
const DELETED = "pkg/gone.spec.ts";
const ALSO_DELETED = "pkg/also-gone.spec.ts";

describe("delegate allow-removal", () => {
  const { delegate, repo } = delegateSandbox(SESSION);
  let planFile: string;

  const status = async () => (await delegate("status")).stdout;
  const task = async () => (await readCoordinatorState(SESSION))?.task;

  const startTask = async (plan = planFile) => {
    expect((await delegate("start", "--plan", plan)).code).toBe(0);
    const started = await delegate("task");
    expect(started.code, started.stderr).toBe(0);
  };

  beforeEach(async () => {
    planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
  });

  test("records the paths for the current task and prints them; a second call adds without duplicates", async () => {
    await startTask();

    const first = await delegate("allow-removal", FIRST);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain(FIRST);
    expect((await task())?.allowedRemovals).toEqual([FIRST]);

    const second = await delegate("allow-removal", FIRST, SECOND);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout.split(FIRST)).toHaveLength(2);
    expect(second.stdout).toContain(SECOND);
    expect((await task())?.allowedRemovals).toEqual([FIRST, SECOND]);
  });

  test("status shows the allowed removals on a line of their own, apart from the allowed deletions", async () => {
    await startTask();
    expect((await delegate("allow-deletion", DELETED)).code).toBe(0);
    expect((await delegate("allow-removal", FIRST)).code).toBe(0);

    const lines = (await status()).split("\n");
    const removalLine = lines.find((line) => line.includes(FIRST));
    const deletionLine = lines.find((line) => line.includes(DELETED));
    expect(removalLine).toBeDefined();
    expect(deletionLine).toBeDefined();
    expect(removalLine).not.toBe(deletionLine);
    expect(removalLine).not.toContain(DELETED);
    expect(deletionLine).not.toContain(FIRST);
  });

  test("capturing the next task ends the allowance", async () => {
    await startTask();
    expect((await delegate("allow-removal", FIRST)).code).toBe(0);

    expect((await delegate("task")).code).toBe(0);
    expect((await task())?.allowedRemovals).toBeUndefined();
    expect(await status()).not.toContain(FIRST);
  });

  test("starting a different plan ends the allowance", async () => {
    await startTask();
    expect((await delegate("allow-removal", FIRST)).code).toBe(0);

    const nextPlan = join(repo(), "next-plan.md");
    await Bun.write(nextPlan, "# next plan\n");
    expect((await delegate("start", "--plan", nextPlan)).code).toBe(0);
    expect((await task())?.allowedRemovals).toBeUndefined();
    expect(await status()).not.toContain(FIRST);
  });

  test("stop ends the allowance", async () => {
    await startTask();
    expect((await delegate("allow-removal", FIRST)).code).toBe(0);

    expect((await delegate("stop")).code).toBe(0);
    expect(await readCoordinatorState(SESSION)).toBeNull();
    await startTask();
    expect(await status()).not.toContain(FIRST);
  });

  test("no path: exits 1 and names allow-removal", async () => {
    await startTask();

    const refused = await delegate("allow-removal");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("allow-removal");
    expect((await task())?.allowedRemovals).toBeUndefined();
  });

  test("no active delegation: exits 1 and says so", async () => {
    const refused = await delegate("allow-removal", FIRST);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("active delegation");
    expect(await readCoordinatorState(SESSION)).toBeNull();
  });

  test("a delegation without a task boundary: exits 1 and names mimir-cc delegate task", async () => {
    expect((await delegate("start", "--plan", planFile)).code).toBe(0);

    const refused = await delegate("allow-removal", FIRST);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("mimir-cc delegate task");
    expect(await task()).toBeUndefined();
  });

  test("granting removals keeps the task's allowed deletions, and granting deletions keeps its allowed removals", async () => {
    await startTask();
    expect((await delegate("allow-deletion", DELETED)).code).toBe(0);

    expect((await delegate("allow-removal", FIRST)).code).toBe(0);
    expect((await task())?.allowedDeletions).toEqual([DELETED]);

    expect((await delegate("allow-deletion", ALSO_DELETED)).code).toBe(0);
    expect((await task())?.allowedRemovals).toEqual([FIRST]);
    expect((await task())?.allowedDeletions).toEqual([DELETED, ALSO_DELETED]);
  });
});
