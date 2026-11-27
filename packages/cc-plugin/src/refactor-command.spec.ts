/**
 * `mimir-cc delegate task --refactor` — the coordinator marks the task it
 * starts as a refactor. The mark lives on the task boundary and ends with
 * the task. Git is canned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readCoordinatorState } from "@mimir/plugin-core/guard";
import { delegateSandbox, HEAD } from "./delegate-sandbox";

// Neither the session nor the sandbox path may contain the word the status
// assertions look for: both are printed by `delegate status`.
const SESSION = "sess-task-mark";
const REFACTOR_FLAG = "--refactor";
const SAYS_REFACTOR = /refactor/i;

describe("delegate task --refactor", () => {
  const { delegate, repo } = delegateSandbox(SESSION);
  let planFile: string;

  const status = async () => (await delegate("status")).stdout;
  const task = async () => (await readCoordinatorState(SESSION))?.task;

  const startRefactor = async (plan = planFile) => {
    expect((await delegate("start", "--plan", plan)).code).toBe(0);
    const started = await delegate("task", REFACTOR_FLAG);
    expect(started.code, started.stderr).toBe(0);
    return started;
  };

  beforeEach(async () => {
    planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
  });

  test("captures the task base, marks the task as a refactor and says so", async () => {
    const started = await startRefactor();

    expect(started.stdout).toMatch(SAYS_REFACTOR);
    const marked = await task();
    expect(marked?.base).toBe(HEAD);
    expect(marked?.worktree).toBe(repo());
    expect(marked?.refactor).toBe(true);
  });

  test("status says the current task is a refactor only when it is marked", async () => {
    expect((await delegate("start", "--plan", planFile)).code).toBe(0);
    expect((await delegate("task")).code).toBe(0);
    expect(await status()).not.toMatch(SAYS_REFACTOR);

    expect((await delegate("task", REFACTOR_FLAG)).code).toBe(0);
    expect(await status()).toMatch(SAYS_REFACTOR);
  });

  test("a plain delegate task afterwards starts a task that is not marked", async () => {
    await startRefactor();

    const plain = await delegate("task");
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).not.toMatch(SAYS_REFACTOR);
    expect((await task())?.refactor).toBeFalsy();
    expect(await status()).not.toMatch(SAYS_REFACTOR);
  });

  test("any other argument exits 1, changes nothing, and names --refactor as the one it accepts", async () => {
    await startRefactor();
    const before = await readCoordinatorState(SESSION);

    for (const extra of [["--force"], ["refactor"], [REFACTOR_FLAG, "extra"]]) {
      const refused = await delegate("task", ...extra);
      expect(refused.code, extra.join(" ")).toBe(1);
      expect(refused.stderr).toContain(REFACTOR_FLAG);
      expect(await readCoordinatorState(SESSION)).toEqual(before);
    }
  });

  test("starting the same plan again keeps the task boundary and its mark", async () => {
    await startRefactor();
    const before = await task();

    expect((await delegate("start", "--plan", planFile)).code).toBe(0);
    const after = await task();
    expect(after?.base).toBe(before?.base);
    expect(after?.refactor).toBe(true);
    expect(await status()).toMatch(SAYS_REFACTOR);
  });

  test("starting a different plan ends the task and its mark", async () => {
    await startRefactor();

    const nextPlan = join(repo(), "next-plan.md");
    await Bun.write(nextPlan, "# next plan\n");
    expect((await delegate("start", "--plan", nextPlan)).code).toBe(0);
    expect(await task()).toBeUndefined();
    expect(await status()).not.toMatch(SAYS_REFACTOR);
  });

  test("stop ends the task and its mark", async () => {
    await startRefactor();

    expect((await delegate("stop")).code).toBe(0);
    expect(await readCoordinatorState(SESSION)).toBeNull();
    expect((await delegate("start", "--plan", planFile)).code).toBe(0);
    expect((await delegate("task")).code).toBe(0);
    expect((await task())?.refactor).toBeFalsy();
    expect(await status()).not.toMatch(SAYS_REFACTOR);
  });
});
