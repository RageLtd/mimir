/**
 * The task-provenance check: what it hands the gate for a session's task,
 * and what it refuses. The session's state file and the directories are
 * real; git is canned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  coordinatorStatePath,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { cannedGit } from "@mimir/plugin-core/verify/testing";
import { delegateSandbox, HEAD } from "./delegate-sandbox";
import { taskProvenance } from "./task-state";

const SESSION = "sess-provenance";
const WORKER = "impl-worker";
const REMOVABLE = "pkg/first.spec.ts";
const DELETABLE = "pkg/gone.spec.ts";

describe("taskProvenance", () => {
  const { addWorker, repo, root, worktreeGit } = delegateSandbox(SESSION);
  let planFile: string;

  /** An active delegation whose task began at HEAD in the project directory. */
  const startTask = (extra: Record<string, unknown> = {}) =>
    writeCoordinatorState(SESSION, {
      active: true,
      planFile,
      task: { base: HEAD, worktree: repo(), ...extra },
    });

  beforeEach(async () => {
    planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
  });

  test("no delegation for the session → nothing to prove", async () => {
    expect(await taskProvenance(SESSION, repo(), cannedGit({}))).toBeNull();
    expect(await taskProvenance(undefined, repo(), cannedGit({}))).toBeNull();
  });

  test("a worker's worktree gets the task's base, allowances and mark, with both worktrees named", async () => {
    await startTask({
      allowedDeletions: [DELETABLE],
      allowedRemovals: [REMOVABLE],
      refactor: true,
    });
    const worker = addWorker(WORKER);

    expect(await taskProvenance(SESSION, worker, worktreeGit(worker))).toEqual({
      base: HEAD,
      allowedDeletions: [DELETABLE],
      allowedRemovals: [REMOVABLE],
      refactor: true,
      integrationWorktree: repo(),
      worktree: worker,
      planPath: "plan.md",
    });
  });

  test("a task with no allowances and no mark reports none", async () => {
    await startTask();
    const worker = addWorker(WORKER);

    const task = await taskProvenance(SESSION, worker, worktreeGit(worker));
    expect(task?.allowedDeletions).toEqual([]);
    expect(task?.allowedRemovals).toEqual([]);
    expect(task?.refactor).toBe(false);
  });

  test("the integration worktree itself is reported as both worktrees", async () => {
    await startTask();

    const task = await taskProvenance(SESSION, repo(), worktreeGit(repo()));
    expect(task?.worktree).toBe(repo());
    expect(task?.integrationWorktree).toBe(repo());
  });

  test("a directory nested in a worktree is reported as that worktree's top level", async () => {
    await startTask();
    const worker = addWorker(WORKER);
    const nested = join(worker, "nested", "directory");
    mkdirSync(nested, { recursive: true });

    const task = await taskProvenance(
      SESSION,
      nested,
      worktreeGit(worker, {
        [`${nested}$ rev-parse --git-common-dir`]: `${join(repo(), ".git")}\n`,
        [`${nested}$ rev-parse --show-toplevel`]: `${worker}\n`,
      }),
    );
    expect(task?.worktree).toBe(worker);
  });

  test("an active delegation with no task boundary is refused, naming delegate task", async () => {
    await writeCoordinatorState(SESSION, { active: true, planFile });

    await expect(
      taskProvenance(SESSION, repo(), cannedGit({})),
    ).rejects.toThrow("mimir-cc delegate task");
  });

  test("a task base that is not a commit id is refused before git is asked", async () => {
    await startTask({ base: "broken" });

    await expect(
      taskProvenance(SESSION, repo(), cannedGit({})),
    ).rejects.toThrow("Missing or malformed task base");
  });

  test("a state file that cannot be parsed is refused, not read as no delegation", async () => {
    await Bun.write(coordinatorStatePath(SESSION), '{"active":true,');

    await expect(
      taskProvenance(SESSION, repo(), cannedGit({})),
    ).rejects.toThrow("Cannot read coordinator task provenance");
  });

  test("a worktree of a different repository is refused", async () => {
    await startTask();
    const other = join(root(), "other");
    mkdirSync(join(other, ".git"), { recursive: true });

    await expect(
      taskProvenance(
        SESSION,
        other,
        worktreeGit(other, {
          [`${other}$ rev-parse --git-common-dir`]: ".git\n",
        }),
      ),
    ).rejects.toThrow("different Git repository");
  });

  test("a worktree whose HEAD does not descend from the task base is refused", async () => {
    await startTask();
    const worker = addWorker(WORKER);

    await expect(
      taskProvenance(
        SESSION,
        worker,
        worktreeGit(worker, {
          [`${worker}$ merge-base --is-ancestor ${HEAD} HEAD`]: { code: 1 },
        }),
      ),
    ).rejects.toThrow("Cannot validate task repository");
  });
});
