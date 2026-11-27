/**
 * Coordinator mode state — one small JSON file per session under
 * `~/.mimir/agents/`, written by the delegation skill when a plan is
 * opened and cleared when the delegation ends. The guard reads it to
 * decide whether the coordinator role is active for a tool call.
 *
 * Absent or unparseable → inactive: a broken state file must never lock
 * the developer out of their own session. A parseable file whose task
 * boundary is malformed is the one exception — reading it throws, and
 * the guards deny rather than verify against a borrowed base.
 */

import { join } from "node:path";
import { createLoggerFactory } from "../logger";
import { attempt } from "../result";
import { asRecord } from "../toml";
import { errMessage, mimirHome } from "../util";

const log =
  createLoggerFactory("mimir-plugin").createLogger("coordinator-state");

export type CoordinatorState = {
  readonly active: boolean;
  /** Absolute path to the delegation plan the guard requires before spawning. */
  readonly planFile: string;
  /**
   * The current red → green → review task's boundary — one per session,
   * not the whole plan. Captured host-side; verification and review diff
   * from `base` so the task's committed red tests count and earlier
   * tasks' don't.
   */
  readonly task?: {
    /** Full commit id of HEAD when the task began. */
    readonly base: string;
    /** The integration worktree the base was captured in. */
    readonly worktree: string;
    /**
     * Repository-relative test files the coordinator allows this task to
     * delete. Kept on the task so the allowance ends when the task does.
     */
    readonly allowedDeletions?: readonly string[];
    /**
     * Repository-relative test files the coordinator allows this task to
     * lose assertions in. Held beside `allowedDeletions`, for the same reason.
     */
    readonly allowedRemovals?: readonly string[];
    /**
     * The task keeps behaviour, so the verify gate holds it to the existing
     * suite: no coverage rule, and no test may change, inline ones included.
     */
    readonly refactor?: boolean;
  };
};

type TaskAllowance = "allowedDeletions" | "allowedRemovals";

const stateDir = () => join(mimirHome(), "agents");

const safeSessionId = (sessionId: string) =>
  sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");

export const coordinatorStatePath = (sessionId: string) =>
  join(stateDir(), `${safeSessionId(sessionId)}.json`);

/** An allowance's paths; undefined when absent, a throw when malformed. */
const readAllowance = (allowed: unknown, what: string) => {
  if (allowed === undefined) return undefined;
  const paths = Array.isArray(allowed)
    ? allowed.filter((path) => typeof path === "string")
    : [];
  if (!Array.isArray(allowed) || paths.length !== allowed.length)
    throw new Error(`Invalid coordinator task state: cannot read ${what}.`);
  return paths;
};

const readTask = (raw: unknown) => {
  if (raw === undefined) return undefined;
  const task = asRecord(raw);
  if (
    !task ||
    typeof task.base !== "string" ||
    typeof task.worktree !== "string"
  )
    throw new Error(
      "Invalid coordinator task state: cannot verify the task base.",
    );
  const allowedDeletions = readAllowance(
    task.allowedDeletions,
    "the allowed test deletions",
  );
  const allowedRemovals = readAllowance(
    task.allowedRemovals,
    "the allowed assertion removals",
  );
  const { refactor } = task;
  if (refactor !== undefined && typeof refactor !== "boolean")
    throw new Error(
      "Invalid coordinator task state: cannot read the refactor mark.",
    );
  return {
    base: task.base,
    worktree: task.worktree,
    ...(allowedDeletions ? { allowedDeletions } : {}),
    ...(allowedRemovals ? { allowedRemovals } : {}),
    ...(refactor !== undefined ? { refactor } : {}),
  };
};

export const readCoordinatorState = async (sessionId: string) => {
  const file = Bun.file(coordinatorStatePath(sessionId));
  if (!(await file.exists())) return null;
  // Serialisation boundary: the file is JSON we wrote, but we still
  // narrow before trusting it.
  const [err, raw] = await attempt(async () => (await file.json()) as unknown);
  if (err) {
    log.warn("coordinator state unreadable — treating as inactive", {
      sessionId,
      error: errMessage(err),
    });
    return null;
  }
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.active !== "boolean" ||
    typeof record.planFile !== "string"
  ) {
    return null;
  }
  const task = readTask(record.task);
  return {
    active: record.active,
    planFile: record.planFile,
    ...(task ? { task } : {}),
  } satisfies CoordinatorState;
};

export const writeCoordinatorState = async (
  sessionId: string,
  state: CoordinatorState,
) => {
  await Bun.write(
    coordinatorStatePath(sessionId),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

type TaskState = CoordinatorState & {
  readonly task: NonNullable<CoordinatorState["task"]>;
};

/**
 * Add `paths` to one of the current task's allowances and write the
 * state back. Returns that allowance in full.
 */
const allowOnTask = async (
  key: TaskAllowance,
  sessionId: string,
  state: TaskState,
  paths: readonly string[],
) => {
  const allowed = [...new Set([...(state.task[key] ?? []), ...paths])];
  await writeCoordinatorState(sessionId, {
    ...state,
    task: { ...state.task, [key]: allowed },
  });
  return allowed;
};

/** Add `paths` to the test files the current task may delete. */
export const allowTaskDeletions = (
  sessionId: string,
  state: TaskState,
  paths: readonly string[],
) => allowOnTask("allowedDeletions", sessionId, state, paths);

/** Add `paths` to the test files the current task may lose assertions in. */
export const allowTaskRemovals = (
  sessionId: string,
  state: TaskState,
  paths: readonly string[],
) => allowOnTask("allowedRemovals", sessionId, state, paths);

/** What each allowance action grants on the task, and how it is printed. */
export const TASK_ALLOWANCES = {
  "allow-deletion": {
    allow: allowTaskDeletions,
    label: "allowed test deletions",
  },
  "allow-removal": {
    allow: allowTaskRemovals,
    label: "allowed assertion removals",
  },
} as const;

/** How a host prints the task's refactor mark. */
export const REFACTOR_LABEL = "marked as a refactor";

export const clearCoordinatorState = async (sessionId: string) => {
  const file = Bun.file(coordinatorStatePath(sessionId));
  if (await file.exists()) await file.delete();
};
