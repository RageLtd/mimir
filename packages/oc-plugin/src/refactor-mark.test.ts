/**
 * The coordinator's refactor mark on OpenCode: `mimir_delegate` action
 * `task` with `refactor: true` captures the task boundary and marks it,
 * `status` reports the mark, and the mark lives on the task record, so it
 * ends with the task. Starting a task is the coordinator's call alone. Git
 * is canned.
 */

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readCoordinatorState } from "@mimir/plugin-core/guard";
import {
  COORDINATOR,
  contextFor,
  delegateSandbox,
  HEAD,
  NEXT_HEAD,
  WORKER_SESSION,
} from "./delegate-sandbox";
import { delegateTool } from "./delegate-tools";

// Neither session id nor any fixture path may contain the word the status
// checks look for, so a missing mark cannot be mistaken for a present one.
const REMOVABLE = "pkg/first.test.ts";
const MARK = /refactor/i;
const COORDINATORS_CALL = /coordinator's call/i;

const { delegate, home, moveHead, root, startDelegation } = delegateSandbox();

const currentTask = async () => (await readCoordinatorState(COORDINATOR))?.task;

test("the tool's arguments offer an optional boolean refactor", () => {
  const tool = delegateTool("/project");
  expect(tool.input.properties).toHaveProperty("refactor");
  expect(tool.input.properties).toMatchObject({
    refactor: { type: "boolean" },
  });
  expect(tool.input.required).not.toContain("refactor");
});

test("task with refactor captures the task base, marks the task as a refactor, and says so", async () => {
  await startDelegation();

  const reply = await delegate({ action: "task", refactor: true });
  expect(reply).toContain(HEAD);
  expect(reply).toMatch(MARK);
  const task = await currentTask();
  expect(task?.base).toBe(HEAD);
  expect(resolve(task?.worktree ?? "")).toBe(resolve(root()));
  expect(task?.refactor).toBe(true);
});

test("status says the current task is a refactor when it is marked", async () => {
  await startDelegation();
  await delegate({ action: "task", refactor: true });

  expect(await delegate({ action: "status" })).toMatch(MARK);
});

test("status says nothing of a refactor when the current task is not marked", async () => {
  await startDelegation();
  await delegate({ action: "task" });

  const status = await delegate({ action: "status" });
  expect(status).toContain("delegation active");
  expect(status).not.toMatch(MARK);
});

test("a plain task after a marked one starts a task that is not marked", async () => {
  await startDelegation();
  await delegate({ action: "task", refactor: true });
  expect((await currentTask())?.refactor).toBe(true);

  await delegate({ action: "task" });
  const task = await currentTask();
  expect(task?.base).toBeDefined();
  expect(task?.refactor ?? false).toBe(false);
  expect(await delegate({ action: "status" })).not.toMatch(MARK);
});

test("start with the same plan keeps the task boundary and its refactor mark", async () => {
  const planFile = await startDelegation();
  await delegate({ action: "task", refactor: true });
  const before = await currentTask();
  expect(before?.refactor).toBe(true);

  await delegate({ action: "start", planFile });
  expect(await currentTask()).toEqual(before);
  expect(await delegate({ action: "status" })).toMatch(MARK);
});

test("start with a different plan ends the task and its refactor mark", async () => {
  await startDelegation();
  await delegate({ action: "task", refactor: true });
  expect((await currentTask())?.refactor).toBe(true);

  const nextPlan = join(home(), "next-plan.md");
  await Bun.write(nextPlan, "# Next plan\n");
  await delegate({ action: "start", planFile: nextPlan });
  expect(await currentTask()).toBeUndefined();
  expect(await delegate({ action: "status" })).not.toMatch(MARK);
});

test("stop ends the task and its refactor mark, including after the delegation starts again", async () => {
  const planFile = await startDelegation();
  await delegate({ action: "task", refactor: true });
  expect((await currentTask())?.refactor).toBe(true);

  await delegate({ action: "stop" });
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
  await delegate({ action: "start", planFile });
  expect(await currentTask()).toBeUndefined();
  await delegate({ action: "task" });
  expect((await currentTask())?.refactor ?? false).toBe(false);
  expect(await delegate({ action: "status" })).not.toMatch(MARK);
});

test("a worker's session cannot start a task, with or without refactor, and the task boundary stays as it was", async () => {
  await startDelegation();
  await delegate({ action: "task", refactor: true });
  await delegate({ action: "allow-removal", paths: [REMOVABLE] });
  // HEAD moves on, so a recaptured boundary would carry a different base.
  moveHead(NEXT_HEAD);
  const before = await currentTask();
  expect(before?.refactor).toBe(true);
  expect(before?.allowedRemovals).toEqual([REMOVABLE]);

  const workers = [
    contextFor(WORKER_SESSION, "mimir-test"),
    contextFor(COORDINATOR, "mimir-impl"),
  ];
  for (const worker of workers) {
    for (const input of [
      { action: "task" },
      { action: "task", refactor: true },
      { action: "task", refactor: false },
    ]) {
      const refused = await delegate(input, worker);
      expect(refused).toMatch(COORDINATORS_CALL);
      expect(await currentTask()).toEqual(before);
    }
  }
  expect(await readCoordinatorState(WORKER_SESSION)).toBeNull();
});
