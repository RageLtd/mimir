/**
 * The context-free review prompt.
 *
 * Generated mechanically from the change set so the coordinator cannot
 * leak the plan or its rationale into the review. The reviewer gets the
 * task title and the diff — nothing else, on purpose — and reads the
 * changed files from the worktree itself. A reviewer steeped in the same
 * plan misses the same errors; the cold read is the feature. The
 * reviewer runs `mimir-cc review-prompt` (or `git diff`) in its own
 * context, so nothing relays through the coordinator.
 */

import type { ChangedFile } from "../verify/changes";

export type ReviewPromptInput = {
  readonly title: string;
  readonly files: readonly ChangedFile[];
};

const INSTRUCTIONS = `You are reviewing a change cold. You have the task title and the diff — and nothing else, on purpose. Read the changed files from the worktree you are in (and anything they touch) as you need to; do not ask what the plan was or why a choice was made. Judge what is in front of you.

Report findings ordered by severity — blocker, should-fix, nit — each with file and line, what is wrong, and why it matters. Look for logic errors, unhandled cases, tests that cannot fail or do not exercise the change, style that violates the project's rules, and anything that looks wrong when you don't know why it was written. If there is nothing to report, say "No findings."

Do not edit anything. End your reply with exactly one final line: STATUS: done`;

const renderDiff = (file: ChangedFile) => {
  const parts = [`=== ${file.path} (${file.status})`];
  if (file.removed.length > 0) {
    parts.push("--- removed", ...file.removed.split("\n").map((l) => `- ${l}`));
  }
  if (file.added.length > 0) {
    parts.push("+++ added", ...file.added.split("\n").map((l) => `+ ${l}`));
  }
  return parts.join("\n");
};

export const buildReviewPrompt = (input: ReviewPromptInput) =>
  [
    "<review_task>",
    `Title: ${input.title}`,
    "",
    INSTRUCTIONS,
    "</review_task>",
    "",
    "<diff>",
    input.files.map(renderDiff).join("\n\n"),
    "</diff>",
  ].join("\n");
