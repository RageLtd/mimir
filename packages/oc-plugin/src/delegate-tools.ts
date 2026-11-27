/**
 * In-process tools the `/delegate` playbook calls on OpenCode:
 *
 *   mimir_delegate       start | task | allow-deletion | allow-removal |
 *                        status | stop the coordinator role for the calling
 *                        session (the same state file the guard reads);
 *                        allowed deletions and removals live on the task
 *                        record, so they end with the task, as does the
 *                        refactor mark `task` sets with `refactor: true`
 *   mimir_review_prompt  the context-free review prompt for a worker's
 *                        change — generated, never written by the model
 */

import { resolve } from "node:path";
import {
  clearCoordinatorState,
  REFACTOR_LABEL,
  readCoordinatorState,
  TASK_ALLOWANCES,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import {
  type ChangeSource,
  type CommandRunner,
  gitChanges,
  runCommand,
} from "@mimir/plugin-core/verify";
import { buildReviewPrompt, workerByName } from "@mimir/plugin-core/workers";
import { tool } from "./tool-factory";

const describeState = async (sessionID: string, planFile: string) => {
  const exists = await Bun.file(planFile).exists();
  const lines = [
    `delegation active for session ${sessionID}`,
    `plan: ${planFile}`,
  ];
  if (!exists) {
    lines.push(
      "plan file not written yet — workers cannot be spawned until it exists",
    );
  }
  return lines.join("\n");
};

/** What a worker's session is told when it asks to start a task or for an allowance. */
const WORKER_REFUSALS = {
  task: "Starting a task is the coordinator's call. Stop with STATUS: question if the work needs a new task boundary.",
  "allow-deletion":
    "Allowing a test-file deletion is the coordinator's call. Stop with STATUS: question and name the deleted test files, so the coordinator can allow them.",
  "allow-removal":
    "Allowing an assertion removal is the coordinator's call. Stop with STATUS: question and name the test files that lose assertions, so the coordinator can allow them.",
} as const;

export const delegateTool = (
  directory = process.cwd(),
  worktree = directory,
  run: CommandRunner = runCommand,
) =>
  tool({
    description:
      "Turn the coordinator role on or off. `start` (with planFile) activates the guard. Call `task` once at the beginning of EACH task, before any worker edits: the host captures its Git base. Pass `refactor: true` with `task` when the task keeps behaviour: the gate then drops the coverage rule and blocks any test change; the mark ends with the task. Never call `task` for retries, role assistance, or review fixes. `allow-deletion` (with paths) lets the current task delete those test files; `allow-removal` (with paths) lets it remove assertions from them; each allowance ends with the task. `status` reports state; `stop` restores normal operation.",
    args: {
      action: {
        type: "string",
        description:
          "start | task | allow-deletion | allow-removal | status | stop",
        enum: [
          "start",
          "task",
          "allow-deletion",
          "allow-removal",
          "status",
          "stop",
        ],
      },
      planFile: {
        type: "string",
        description: "Path to the delegation plan (required for start).",
        optional: true,
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Test files the current task may delete (allow-deletion) or remove assertions from (allow-removal), relative to the repository root (required for both).",
        optional: true,
      },
      refactor: {
        type: "boolean",
        description:
          "Mark the task as a refactor (task only): no coverage rule, and no test may change since the task base.",
        optional: true,
      },
    },
    async execute(args, context) {
      const sessionID = context.sessionID;
      switch (args.action) {
        case "start": {
          if (!args.planFile) return "mimir_delegate start needs planFile.";
          const planFile = resolve(directory, args.planFile);
          const state = await readCoordinatorState(sessionID);
          if (state?.active && state.planFile === planFile)
            return describeState(sessionID, planFile);
          await writeCoordinatorState(sessionID, { active: true, planFile });
          return describeState(sessionID, planFile);
        }
        case "task": {
          if (context.agent && workerByName(context.agent))
            return WORKER_REFUSALS.task;
          const state = await readCoordinatorState(sessionID);
          if (!state?.active)
            return "mimir_delegate task needs an active delegation; call start first.";
          // A failed new boundary must not leave the previous task's coverage usable.
          await writeCoordinatorState(sessionID, {
            active: state.active,
            planFile: state.planFile,
          });
          if (!(await Bun.file(state.planFile).exists()))
            return "mimir_delegate task needs the plan file to exist first.";
          const head = await run(
            ["git", "rev-parse", "--verify", "HEAD"],
            worktree,
          );
          if (
            head.code !== 0 ||
            head.timedOut ||
            !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())
          )
            throw new Error(
              `Cannot capture task base: ${head.stderr || head.stdout}`,
            );
          const base = head.stdout.trim();
          await writeCoordinatorState(sessionID, {
            ...state,
            task: {
              base,
              worktree: resolve(worktree),
              ...(args.refactor ? { refactor: true } : {}),
            },
          });
          return `task started at ${base}${args.refactor ? `, ${REFACTOR_LABEL}` : ""}; keep this boundary through retries and review fixes.`;
        }
        case "allow-deletion":
        case "allow-removal": {
          if (context.agent && workerByName(context.agent))
            return WORKER_REFUSALS[args.action];
          if (!args.paths || args.paths.length === 0)
            return `mimir_delegate ${args.action} needs paths: one or more test file paths, relative to the repository root.`;
          const state = await readCoordinatorState(sessionID);
          if (!state?.active)
            return `mimir_delegate ${args.action} needs an active delegation; call start first.`;
          if (!state.task)
            return `mimir_delegate ${args.action} needs a task boundary; call action: "task" first.`;
          const grant = TASK_ALLOWANCES[args.action];
          const allowed = await grant.allow(
            sessionID,
            { ...state, task: state.task },
            args.paths,
          );
          return `${grant.label} for this task: ${allowed.join(", ")}`;
        }
        case "status": {
          const state = await readCoordinatorState(sessionID);
          if (!state?.active)
            return `no active delegation for session ${sessionID}`;
          const lines = [await describeState(sessionID, state.planFile)];
          if (state.task?.refactor)
            lines.push(`current task ${REFACTOR_LABEL}`);
          const deletions = state.task?.allowedDeletions ?? [];
          if (deletions.length > 0)
            lines.push(
              `${TASK_ALLOWANCES["allow-deletion"].label}: ${deletions.join(", ")}`,
            );
          const removals = state.task?.allowedRemovals ?? [];
          if (removals.length > 0)
            lines.push(
              `${TASK_ALLOWANCES["allow-removal"].label}: ${removals.join(", ")}`,
            );
          return lines.join("\n");
        }
        case "stop":
          await clearCoordinatorState(sessionID);
          return `delegation cleared for session ${sessionID}`;
        default:
          return assertNever(args.action);
      }
    },
  });

const assertNever = (value: never) => {
  throw new Error(`Unhandled delegate action: ${String(value)}`);
};

export const reviewPromptTool = (
  directory = process.cwd(),
  coordinatorSession = async (sessionID: string) => sessionID,
  defaultWorktree = directory,
  changes: ChangeSource = gitChanges(runCommand),
) =>
  tool({
    description:
      "Generate the context-free review prompt for a worker's change: task title, diff, and current file content — nothing else. Hand the result to mimir-review verbatim; do not add the plan or your rationale.",
    args: {
      title: { type: "string", description: "The task title, one line." },
      worktree: {
        type: "string",
        description:
          "Directory holding the change. Defaults to the project directory.",
        optional: true,
      },
    },
    async execute(args, context) {
      const worktree =
        args.worktree === undefined
          ? resolve(defaultWorktree)
          : resolve(directory, args.worktree);
      const state = await readCoordinatorState(
        await coordinatorSession(context.sessionID),
      );
      if (
        state?.active &&
        (!state.task || resolve(state.task.worktree) !== worktree)
      )
        return "Cannot review: missing task base for this worktree.";
      const set = await changes.collect(
        worktree,
        state?.active ? state.task?.base : undefined,
      );
      if (!set) return `${worktree} is not a git worktree.`;
      const files = set.files.filter(
        (file) =>
          !state?.active ||
          resolve(worktree, file.path) !== resolve(state.planFile),
      );
      if (files.length === 0) {
        return `No changes in ${worktree} against its base — nothing to review.`;
      }
      return buildReviewPrompt({ title: args.title, files });
    },
  });
