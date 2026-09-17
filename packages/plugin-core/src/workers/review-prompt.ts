/**
 * The context-free review prompt.
 *
 * Generated mechanically from the change set so the coordinator cannot
 * leak the plan or its rationale into the review. The reviewer gets the
 * task title, the diff, and the current content of each changed file —
 * nothing else, on purpose. A reviewer steeped in the same plan misses
 * the same errors; the cold read is the feature.
 */

import type { ChangedFile } from "../verify/changes";

export type ReviewPromptInput = {
  readonly title: string;
  readonly files: readonly ChangedFile[];
  /** Cap on lines of file content shown per file. */
  readonly maxLinesPerFile?: number;
};

const DEFAULT_MAX_LINES = 400;

const INSTRUCTIONS = `You are reviewing a change cold. You have the task title, the diff, and the current content of each changed file — and nothing else, on purpose. Do not ask what the plan was or why a choice was made; judge what is in front of you.

Report findings ordered by severity — blocker, should-fix, nit — each with file and line, what is wrong, and why it matters. Look for logic errors, unhandled cases, tests that cannot fail or do not exercise the change, style that violates the project's rules, and anything that looks wrong when you don't know why it was written. If there is nothing to report, say "No findings."

Do not edit anything. End your reply with exactly one final line: STATUS: done`;

const truncate = (text: string, maxLines: number) => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines truncated)`;
};

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

const renderContent = (file: ChangedFile, maxLines: number) =>
  file.after === null
    ? `=== ${file.path} (deleted)`
    : `=== ${file.path}\n${truncate(file.after, maxLines)}`;

export const buildReviewPrompt = (input: ReviewPromptInput) => {
  const maxLines = input.maxLinesPerFile ?? DEFAULT_MAX_LINES;
  return [
    "<review_task>",
    `Title: ${input.title}`,
    "",
    INSTRUCTIONS,
    "</review_task>",
    "",
    "<diff>",
    input.files.map(renderDiff).join("\n\n"),
    "</diff>",
    "",
    "<files>",
    input.files.map((f) => renderContent(f, maxLines)).join("\n\n"),
    "</files>",
  ].join("\n");
};
