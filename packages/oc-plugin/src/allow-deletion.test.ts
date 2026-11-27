/**
 * The coordinator's allowed test-file deletions on OpenCode:
 * `mimir_delegate` action `allow-deletion` records the deleted test files
 * the current task may fold away, `status` shows them, and the task
 * boundary ends them. That the worker gate hands them to the verify gate is
 * held in worker-gate.test.ts. Git is canned.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { readCoordinatorState } from "@mimir/plugin-core/guard";
import {
  COORDINATOR,
  contextFor,
  coordinator,
  delegateSandbox,
  WORKER_SESSION,
} from "./delegate-sandbox";
import { delegateTool } from "./delegate-tools";

// No path is a substring of another.
const FIRST = "pkg/first.test.ts";
const SECOND = "pkg/second.test.ts";

const worker = contextFor(WORKER_SESSION, "mimir-test");

const { delegate, home, startDelegation } = delegateSandbox();

const allowed = async () =>
  (await readCoordinatorState(COORDINATOR))?.task?.allowedDeletions ?? [];

test("the tool declares allow-deletion and an optional paths array", () => {
  const tool = delegateTool("/project");
  expect(tool.input.required).toEqual(["action"]);
  expect(tool.input.properties.action).toMatchObject({
    enum: expect.arrayContaining(["allow-deletion"]),
  });
  expect(tool.input.properties).toMatchObject({
    paths: { type: "array", items: { type: "string" } },
  });
});

test("records the paths for the current task, adds on a second call, and status shows them", async () => {
  await startDelegation();
  await delegate({ action: "task" });

  await delegate({ action: "allow-deletion", paths: [FIRST] });
  expect(await allowed()).toEqual([FIRST]);
  const partial = await delegate({ action: "status" });
  expect(partial).toContain(FIRST);
  expect(partial).not.toContain(SECOND);

  await delegate({ action: "allow-deletion", paths: [SECOND] });
  expect([...(await allowed())].sort()).toEqual([FIRST, SECOND]);
  const shown = await delegate({ action: "status" });
  expect(shown).toContain(FIRST);
  expect(shown).toContain(SECOND);
});

test("capturing the next task allows nothing", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: "allow-deletion", paths: [FIRST, SECOND] });
  expect([...(await allowed())].sort()).toEqual([FIRST, SECOND]);

  await delegate({ action: "task" });
  expect(await allowed()).toEqual([]);
  expect(await delegate({ action: "status" })).not.toContain(FIRST);
});

test("starting a different plan allows nothing", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: "allow-deletion", paths: [FIRST] });
  expect(await allowed()).toEqual([FIRST]);

  const nextPlan = join(home(), "next-plan.md");
  await Bun.write(nextPlan, "# Next plan\n");
  await delegate({ action: "start", planFile: nextPlan });
  await delegate({ action: "task" });
  expect(await allowed()).toEqual([]);
  expect(await delegate({ action: "status" })).not.toContain(FIRST);
});

test("stop allows nothing, including after the delegation starts again", async () => {
  const planFile = await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: "allow-deletion", paths: [FIRST] });
  expect(await allowed()).toEqual([FIRST]);

  await delegate({ action: "stop" });
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
  await delegate({ action: "start", planFile });
  await delegate({ action: "task" });
  expect(await allowed()).toEqual([]);
  expect(await delegate({ action: "status" })).not.toContain(FIRST);
});

test("no paths: records nothing and says the paths are missing", async () => {
  await startDelegation();
  await delegate({ action: "task" });

  for (const input of [
    { action: "allow-deletion" },
    { action: "allow-deletion", paths: [] },
  ]) {
    const refused = await delegate(input);
    expect(refused).toContain("allow-deletion");
    expect(refused).toContain("paths");
  }
  expect(await allowed()).toEqual([]);
});

test("no active delegation: records nothing and says so", async () => {
  const refused = await delegate(
    { action: "allow-deletion", paths: [FIRST] },
    coordinator,
  );
  expect(refused).toContain("active delegation");
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
});

test("a delegation without a task boundary: records nothing and names the task action", async () => {
  await startDelegation();

  const refused = await delegate({ action: "allow-deletion", paths: [FIRST] });
  expect(refused).toContain("task boundary");
  expect((await readCoordinatorState(COORDINATOR))?.task).toBeUndefined();

  await delegate({ action: "task" });
  expect(await allowed()).toEqual([]);
});

test("a worker's session cannot grant the allowance and is told it is the coordinator's call", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: "allow-deletion", paths: [FIRST] });

  const refused = await delegate(
    { action: "allow-deletion", paths: [SECOND] },
    worker,
  );
  expect(refused).toContain("coordinator");
  expect(await allowed()).toEqual([FIRST]);
  expect(await delegate({ action: "status" })).not.toContain(SECOND);
});
