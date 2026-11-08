/**
 * In-process tools the `/delegate` playbook calls on OpenCode:
 *
 *   mimir_delegate       start | task | status | stop the coordinator role for
 *                        the calling session (the same state file the
 *                        guard reads)
 *   mimir_review_prompt  the context-free review prompt for a worker's
 *                        change — generated, never written by the model
 */

import { resolve } from "node:path";
import {
  clearCoordinatorState,
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { collectChanges, runCommand } from "@mimir/plugin-core/verify";
import { buildReviewPrompt } from "@mimir/plugin-core/workers";
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

export const delegateTool = (directory = process.cwd(), worktree = directory) =>
  tool({
    description:
      "Turn the coordinator role on or off. `start` (with planFile) activates the guard. Call `task` once at the beginning of EACH task, before any worker edits: the host captures its Git base. Never call `task` for retries, role assistance, or review fixes. `status` reports state; `stop` restores normal operation.",
    args: {
      action: {
        type: "string",
        description: "start | task | status | stop",
        enum: ["start", "task", "status", "stop"],
      },
      planFile: {
        type: "string",
        description: "Path to the delegation plan (required for start).",
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
          const head = await runCommand(
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
            task: { base, worktree: resolve(worktree) },
          });
          return `task started at ${base}; keep this boundary through retries and review fixes.`;
        }
        case "status": {
          const state = await readCoordinatorState(sessionID);
          if (!state?.active)
            return `no active delegation for session ${sessionID}`;
          return describeState(sessionID, state.planFile);
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
      const changes = await collectChanges(
        runCommand,
        worktree,
        state?.active ? state.task?.base : undefined,
      );
      if (!changes) return `${worktree} is not a git worktree.`;
      const files = changes.files.filter(
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
