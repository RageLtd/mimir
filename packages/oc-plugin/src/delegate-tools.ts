/**
 * In-process tools the `/delegate` playbook calls on OpenCode:
 *
 *   mimir_delegate       start | status | stop the coordinator role for
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
import { tool } from "@opencode-ai/plugin";

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

export const delegateTool = () =>
  tool({
    description:
      "Turn the coordinator role on or off for this session. `start` (with planFile) activates the role guard: no file writes except the plan, no worker spawn until the plan file exists. `stop` restores normal operation. `status` reports the current state.",
    args: {
      action: tool.schema
        .enum(["start", "status", "stop"])
        .describe("start | status | stop"),
      planFile: tool.schema
        .string()
        .optional()
        .describe("Path to the delegation plan (required for start)."),
    },
    async execute(args, context) {
      const sessionID = context.sessionID;
      switch (args.action) {
        case "start": {
          if (!args.planFile) return "mimir_delegate start needs planFile.";
          const planFile = resolve(context.directory, args.planFile);
          await writeCoordinatorState(sessionID, { active: true, planFile });
          return describeState(sessionID, planFile);
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

export const reviewPromptTool = () =>
  tool({
    description:
      "Generate the context-free review prompt for a worker's change: task title, diff, and current file content — nothing else. Hand the result to mimir-review verbatim; do not add the plan or your rationale.",
    args: {
      title: tool.schema.string().describe("The task title, one line."),
      worktree: tool.schema
        .string()
        .optional()
        .describe(
          "Directory holding the change. Defaults to the project directory.",
        ),
    },
    async execute(args, context) {
      const worktree = resolve(context.directory, args.worktree ?? ".");
      const changes = await collectChanges(runCommand, worktree);
      if (!changes) return `${worktree} is not a git worktree.`;
      if (changes.files.length === 0) {
        return `No changes in ${worktree} against its base — nothing to review.`;
      }
      return buildReviewPrompt({ title: args.title, files: changes.files });
    },
  });
