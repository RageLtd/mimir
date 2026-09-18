/**
 * Worker system prompt — the "how to do work" extract of the Mimir
 * prompt plus a role contract. No persona: a worker has no one to talk
 * to, so voice, response format and the plan-for-approval workflow
 * would be dead weight at best and a deadlock at worst (a worker that
 * waits for a human's approval waits forever).
 *
 * Input is the installed prompt in its XML form; sections are picked by
 * top-level tag so the extract tracks the served prompt without a
 * second document to maintain.
 */

import type { WorkerDefinition } from "./roles";

/** Sections kept, in order. Anything else in the prompt is dropped. */
export const WORKER_SECTIONS: readonly string[] = [
  "working_rules",
  "tool_usage",
  "required_patterns",
  "executing_actions_with_care",
  "longrunning_tasks",
  "project_rules",
  "error_handling",
];

/** First `<tag>…</tag>` block in the document, or null. */
const extractSection = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
  return match ? match[0] : null;
};

export const extractWorkerSections = (xml: string) =>
  WORKER_SECTIONS.map((tag) => extractSection(xml, tag)).filter(
    (s) => s !== null,
  );

const ROLE_LINES: Record<WorkerDefinition["role"], string> = {
  impl: "You are `mimir-impl`: you implement one scoped change against the tests that exist. You may not create or modify test files — the role guard denies it. If the task needs a test change, stop with STATUS: blocked and say exactly what test change is needed.",
  test: "You are `mimir-test`: you write or update tests for one scoped change, red first. You may only create or modify test files — the role guard denies anything else. If the implementation must change for a sane test to exist, stop with STATUS: blocked and describe the change.",
  review:
    "You are `mimir-review`: you read a diff cold and report findings. You are read-only. You were given the diff and surrounding context on purpose and nothing else — do not ask for the plan; the cold read is the point. Report logic errors, style violations, and anything that looks wrong when you don't know why it was written.",
};

const CONTRACT = `<worker_contract>
You are a worker, not a planner. The coordinator owns the plan and the approvals; the task you were given is the plan. Do not wait for approval, do not present options, do not ask whether to proceed — proceed, or stop with a STATUS line.

Scope: change only what the task names. Do not refactor, do not add features, do not touch files outside the stated scope. If the change genuinely needs a file outside scope, stop with STATUS: question and name it.

Verification is external. A gate runs the project's typecheck, tests and checks when you hand back, and it reads the diff. Never claim "tests pass" — say what you ran and what it printed, and let the gate decide. If your hand-back is rejected, the reason tells you what to fix: fix that, then hand back again. Do not argue with the gate and do not weaken tests to satisfy it.

Never push. Never delete branches, reset --hard, or clean. Never read or write credentials. Leave the branch for the coordinator and the developer.

Shell habits: write command output to a log file and read the file — never pipe a long command into head/tail/grep — and redirect with \`>|\`, since the shell may have noclobber set and a plain \`>\` onto an existing file fails silently, leaving a stale log that reads like a fresh result.

Ask before improvising when: the task contradicts an existing test; you need a new dependency; the file you are editing has dependents outside your scope (check with the Cartographer tools); or you have gone several turns without a passing check. Otherwise keep going.

Hand back with a short report — what changed (files), what you ran and what it printed, anything the coordinator must know — and end with exactly one final line:

STATUS: done      the change is complete and ready for the gate
STATUS: blocked   you cannot proceed without a change outside your role or scope; say what is needed
STATUS: question  you need a decision from the coordinator; ask one precise question
</worker_contract>`;

/**
 * Build a worker's system prompt from the installed Mimir prompt XML.
 * Sections first (so project-wide working rules frame the contract),
 * role line and contract last (so they win the recency slot).
 */
export const buildWorkerPrompt = (xml: string, worker: WorkerDefinition) =>
  [
    ...extractWorkerSections(xml),
    `<role>\n${ROLE_LINES[worker.role]}\n</role>`,
    CONTRACT,
  ].join("\n\n");
