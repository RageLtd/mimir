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
  };
};

const stateDir = () => join(mimirHome(), "agents");

const safeSessionId = (sessionId: string) =>
  sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");

export const coordinatorStatePath = (sessionId: string) =>
  join(stateDir(), `${safeSessionId(sessionId)}.json`);

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
  return { base: task.base, worktree: task.worktree };
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

export const clearCoordinatorState = async (sessionId: string) => {
  const file = Bun.file(coordinatorStatePath(sessionId));
  if (await file.exists()) await file.delete();
};
