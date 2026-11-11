import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  coordinatorStatePath,
  readCoordinatorState,
} from "@mimir/plugin-core/guard";
import { runCommand } from "@mimir/plugin-core/verify";

// The shared reader tolerates broken session files for ordinary editing; an
// existing CC delegation file must not silently disable its provenance gate.
export const readTaskState = async (session: string | undefined) => {
  if (!session) return null;
  const state = await readCoordinatorState(session);
  if (!state && (await Bun.file(coordinatorStatePath(session)).exists()))
    throw new Error("Cannot read coordinator task provenance.");
  return state;
};

const gitOutput = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(["git", ...args], cwd);
  if (result.code !== 0 || result.timedOut)
    throw new Error(
      `Cannot validate task repository: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
};

export const taskProvenance = async (
  session: string | undefined,
  worktree: string,
) => {
  const state = await readTaskState(session);
  if (!state?.active) return null;
  const task = state.task;
  if (
    !task ||
    !/^[0-9a-f]{40,64}$/.test(task.base) ||
    !isAbsolute(task.worktree)
  )
    throw new Error(
      "Missing or malformed task base; run mimir-cc delegate task before the red worker.",
    );
  const commonDir = async (cwd: string) =>
    realpath(
      resolve(cwd, await gitOutput(cwd, "rev-parse", "--git-common-dir")),
    );
  if ((await commonDir(task.worktree)) !== (await commonDir(worktree)))
    throw new Error(
      "Task worktree and worker belong to a different Git repository.",
    );
  for (const cwd of new Set([task.worktree, worktree])) {
    await gitOutput(cwd, "merge-base", "--is-ancestor", task.base, "HEAD");
  }
  return {
    base: task.base,
    worktree: await realpath(
      await gitOutput(worktree, "rev-parse", "--show-toplevel"),
    ),
    planPath: relative(
      await realpath(task.worktree),
      await realpath(state.planFile),
    ),
  };
};
