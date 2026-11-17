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

Report only what you can show. Look for logic errors, unhandled cases, tests that cannot fail or do not exercise the change, and style that violates the project's rules. A finding needs a trigger that can happen with the code and its callers as they are: name the input, state or sequence, where it comes from, and what goes wrong. Check the trigger is real before you report it — read the caller, the config or the workflow that would produce it. Leave out:
- what would only break after someone later edits or deletes code, mistypes a command, or misconfigures something;
- cases that need an environment the project does not run in;
- a missing test for behaviour another test already holds;
- preferences about naming, layout or wording that no project rule requires.

Give each finding its file and line, and say how you know it: "ran" (what you ran and what it printed) or "read" (the lines that show it). What you could not confirm is not a finding; list it in one line under "Unconfirmed", or drop it.

Order findings by severity, which is by consequence. Blocker: wrong results, lost data, a security hole, or the task's stated behaviour not delivered. Should-fix: a real defect with a reachable trigger, narrower than that. Nit: a project-rule violation or a small cost — three at most. A short report is a good one: if nothing meets this bar, say "No findings."

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
