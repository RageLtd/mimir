/**
 * The task boundary on OpenCode: what `mimir_delegate` `task` refuses, who
 * needs a boundary to be dispatched, and which change set the review prompt
 * asks for and what it leaves out. The change set is handed in and git is
 * canned.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  coordinatorStatePath,
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import type { ChangedFile, ChangeSource } from "@mimir/plugin-core/verify";
import {
  cannedGit,
  changed,
  changeSet,
} from "@mimir/plugin-core/verify/testing";
import { contextFor, delegateSandbox, HEAD } from "./delegate-sandbox";
import { delegateTool, reviewPromptTool } from "./delegate-tools";
import {
  createSessionRoles,
  enforceRoleGuard,
  gateTaskOutput,
} from "./worker-hooks";

const PARENT = "parent";
const parent = contextFor(PARENT, "mimir");
const NOT_A_REPO = { code: 128, stderr: "fatal: not a git repository" };

const SOURCE_CHANGE = changed(
  "value.ts",
  "export const value = 0;\n",
  "export const value = 1;\n",
);

const { root } = delegateSandbox();

/** A change source that records what it was asked and answers `files`. */
const recordingChanges = (files: readonly ChangedFile[]) => {
  const asked: (readonly [string, string | undefined])[] = [];
  const changes: ChangeSource = {
    collect: async (worktree, base) => {
      asked.push([worktree, base]);
      return changeSet(files, { base });
    },
    ownBase: async () => HEAD,
  };
  return { asked, changes };
};

/** An active delegation for `parent` whose task began at HEAD in the project. */
const startTask = (planFile: string) =>
  writeCoordinatorState(PARENT, {
    active: true,
    planFile,
    task: { base: HEAD, worktree: root() },
  });

test("launched from a nested directory, review reads the task worktree by default and resolves an explicit path against the launch directory", async () => {
  await startTask(join(root(), "plan.md"));
  const source = recordingChanges([SOURCE_CHANGE]);
  const review = reviewPromptTool(
    join(root(), "nested"),
    async () => PARENT,
    root(),
    source.changes,
  );

  expect((await review.execute({ title: "Value" }, parent)).content).toContain(
    "value.ts",
  );
  expect(
    (await review.execute({ title: "Value", worktree: ".." }, parent)).content,
  ).toContain("value.ts");
  expect(source.asked).toEqual([
    [root(), HEAD],
    [root(), HEAD],
  ]);
});

test("task refuses an inactive session, and a capture that fails cannot leave an old boundary behind", async () => {
  const tool = delegateTool(
    root(),
    root(),
    cannedGit({ "rev-parse --verify HEAD": NOT_A_REPO }),
  );
  expect((await tool.execute({ action: "task" }, parent)).content).toContain(
    "active delegation",
  );
  const planFile = join(root(), "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState(PARENT, { active: true, planFile });
  await expect(tool.execute({ action: "task" }, parent)).rejects.toThrow(
    "Cannot capture task base",
  );
  expect((await readCoordinatorState(PARENT))?.task).toBeUndefined();
  await startTask(planFile);
  await expect(tool.execute({ action: "task" }, parent)).rejects.toThrow(
    "Cannot capture task base",
  );
  expect((await readCoordinatorState(PARENT))?.task).toBeUndefined();
});

test("utility agents dispatch and return without a task boundary; only Mimir's workers need one", async () => {
  const planFile = join(root(), "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState(PARENT, { active: true, planFile });
  const roles = createSessionRoles(async () => ({}));
  const input = { tool: "subagent", sessionID: PARENT };
  await expect(
    enforceRoleGuard(roles, input, { agent: "mimir-test" }, root()),
  ).rejects.toThrow("task");
  await enforceRoleGuard(roles, input, { agent: "general" }, root());
  const utility = { output: "Explored the tree.", metadata: {} };
  expect(
    await gateTaskOutput(
      {
        tool: "subagent",
        callID: "u",
        sessionID: PARENT,
        args: { agent: "general" },
      },
      utility,
      root(),
    ),
  ).toBe("skip");
  expect(utility.output).toBe("Explored the tree.");
});

test("actual before-hook guard fails closed on malformed task state for edit and shell", async () => {
  await Bun.write(
    coordinatorStatePath(PARENT),
    JSON.stringify({ active: true, planFile: "/plan", task: { base: 123 } }),
  );
  const roles = createSessionRoles(async () => ({}));
  for (const tool of ["edit", "shell"]) {
    await expect(
      enforceRoleGuard(
        roles,
        { tool, sessionID: PARENT },
        { filePath: "a.ts", command: "touch a.ts" },
        root(),
      ),
    ).rejects.toThrow("Invalid coordinator task state");
  }
});

test("cold review leaves the active plan out and keeps every other task change", async () => {
  const planPath = ".mimir/plans/value.md";
  await startTask(join(root(), planPath));
  const source = recordingChanges([
    changed(
      "value.test.ts",
      "test('zero', () => {});\n",
      "test('one', () => {});\n",
    ),
    SOURCE_CHANGE,
    changed("docs/value.md", null, "REVIEWABLE_DOCUMENTATION\n"),
    changed(planPath, null, "PRIVATE_DELEGATION_RATIONALE\n"),
  ]);

  const result = await reviewPromptTool(
    join(root(), "nested"),
    async () => PARENT,
    root(),
    source.changes,
  ).execute({ title: "Value" }, contextFor("review-child", "mimir-review"));
  expect(result.content).toContain("=== value.test.ts");
  expect(result.content).toContain("test('one'");
  expect(result.content).toContain("=== value.ts");
  expect(result.content).toContain("export const value = 1");
  expect(result.content).toContain("REVIEWABLE_DOCUMENTATION");
  expect(result.content).not.toContain(planPath);
  expect(result.content).not.toContain("PRIVATE_DELEGATION_RATIONALE");
});

test("an active plan alone is not a reviewable change", async () => {
  await startTask(join(root(), "plan.md"));
  const source = recordingChanges([
    changed("plan.md", null, "PRIVATE_DELEGATION_RATIONALE\n"),
  ]);

  expect(
    (
      await reviewPromptTool(root(), undefined, root(), source.changes).execute(
        { title: "Value" },
        parent,
      )
    ).content,
  ).toContain("nothing to review");
});
