/**
 * The coordinator's allowed assertion removals on OpenCode:
 * `mimir_delegate` action `allow-removal` records the test files the
 * current task may weaken, `status` shows them, and the task boundary ends
 * them. That the worker gate hands them to the verify gate is held in
 * worker-gate.test.ts. Git is canned.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { readCoordinatorState } from "@mimir/plugin-core/guard";
import {
  COORDINATOR,
  contextFor,
  delegateSandbox,
  WORKER_SESSION,
} from "./delegate-sandbox";

// No path is a substring of another.
const FIRST = "pkg/first.test.ts";
const SECOND = "pkg/second.test.ts";
const FOLDED = "pkg/folded.test.ts";
const ALLOW_REMOVAL = "allow-removal";
const ALLOW_DELETION = "allow-deletion";

const worker = contextFor(WORKER_SESSION, "mimir-test");

const { delegate, home, startDelegation } = delegateSandbox();

const removals = async () =>
  (await readCoordinatorState(COORDINATOR))?.task?.allowedRemovals ?? [];
const deletions = async () =>
  (await readCoordinatorState(COORDINATOR))?.task?.allowedDeletions ?? [];

const linesOf = (text: string, needle: string) =>
  text.split("\n").filter((line) => line.includes(needle));

test("allow-removal records the paths for the current task, returns them, and a second call adds without duplicates", async () => {
  await startDelegation();
  await delegate({ action: "task" });

  const first = await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(first).toContain(FIRST);
  expect(await removals()).toEqual([FIRST]);

  const second = await delegate({
    action: ALLOW_REMOVAL,
    paths: [FIRST, SECOND],
  });
  expect(second).toContain(FIRST);
  expect(second).toContain(SECOND);
  expect([...(await removals())].sort()).toEqual([FIRST, SECOND]);
});

test("status shows the allowed removals on a line of their own, apart from the allowed deletions", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  await delegate({ action: ALLOW_DELETION, paths: [FOLDED] });

  const status = await delegate({ action: "status" });
  const removalLines = linesOf(status, FIRST);
  expect(removalLines).toHaveLength(1);
  expect(removalLines[0]).toContain("removal");
  expect(removalLines[0]).not.toContain(FOLDED);
  const deletionLines = linesOf(status, FOLDED);
  expect(deletionLines).toHaveLength(1);
  expect(deletionLines[0]).not.toContain(FIRST);
});

test("capturing the next task ends the allowed removals", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(await removals()).toEqual([FIRST]);

  await delegate({ action: "task" });
  expect(await removals()).toEqual([]);
  expect(await delegate({ action: "status" })).not.toContain(FIRST);
});

test("starting a different plan ends the allowed removals", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(await removals()).toEqual([FIRST]);

  const nextPlan = join(home(), "next-plan.md");
  await Bun.write(nextPlan, "# Next plan\n");
  await delegate({ action: "start", planFile: nextPlan });
  await delegate({ action: "task" });
  expect(await removals()).toEqual([]);
  expect(await delegate({ action: "status" })).not.toContain(FIRST);
});

test("stop ends the allowed removals, including after the delegation starts again", async () => {
  const planFile = await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(await removals()).toEqual([FIRST]);

  await delegate({ action: "stop" });
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
  await delegate({ action: "start", planFile });
  await delegate({ action: "task" });
  expect(await removals()).toEqual([]);
  expect(await delegate({ action: "status" })).not.toContain(FIRST);
});

test("allow-removal without paths records nothing and names the action and paths", async () => {
  await startDelegation();
  await delegate({ action: "task" });

  for (const input of [
    { action: ALLOW_REMOVAL },
    { action: ALLOW_REMOVAL, paths: [] },
  ]) {
    const refused = await delegate(input);
    expect(refused).toContain(ALLOW_REMOVAL);
    expect(refused).toContain("paths");
  }
  expect(await removals()).toEqual([]);
});

test("allow-removal without an active delegation records nothing and says so", async () => {
  const refused = await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(refused).toContain("active delegation");
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
});

test("allow-removal without a task boundary records nothing and says so", async () => {
  await startDelegation();

  const refused = await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(refused).toContain("task boundary");
  expect((await readCoordinatorState(COORDINATOR))?.task).toBeUndefined();

  await delegate({ action: "task" });
  expect(await removals()).toEqual([]);
});

test("a worker's session cannot allow removals and is told to stop with STATUS: question", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });

  const refused = await delegate(
    { action: ALLOW_REMOVAL, paths: [SECOND] },
    worker,
  );
  expect(refused).toContain("coordinator");
  expect(refused).toContain("STATUS: question");
  expect(await removals()).toEqual([FIRST]);
  expect(await delegate({ action: "status" })).not.toContain(SECOND);
});

test("allowing a removal keeps the allowed deletions, and allowing a deletion keeps the allowed removals", async () => {
  await startDelegation();
  await delegate({ action: "task" });

  await delegate({ action: ALLOW_DELETION, paths: [FOLDED] });
  await delegate({ action: ALLOW_REMOVAL, paths: [FIRST] });
  expect(await deletions()).toEqual([FOLDED]);
  expect(await removals()).toEqual([FIRST]);

  await delegate({ action: ALLOW_DELETION, paths: [SECOND] });
  expect(await removals()).toEqual([FIRST]);
  expect([...(await deletions())].sort()).toEqual([FOLDED, SECOND]);
});
