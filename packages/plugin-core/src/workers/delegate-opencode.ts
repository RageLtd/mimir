/**
 * OpenCode's `/delegate` mechanics: the `mimir_delegate` and
 * `mimir_review_prompt` tools, `task` spawns resumed by id, and every
 * worker sharing the session's directory.
 */

import {
  CHECKINS_HEADING,
  PER_TASK_HEADING,
  POLICY_BRIEFS,
  POLICY_CHECKIN_ANSWER,
  POLICY_CONVENTIONAL_COMMITS,
  POLICY_ESCALATE_CLOSE,
  POLICY_ESCALATE_OPEN,
  POLICY_FINISH_CLOSE,
  POLICY_FINISH_OPEN,
  POLICY_FOLD_CLOSE,
  POLICY_FOLD_OPEN,
  POLICY_IMPL_GATE,
  POLICY_IMPL_PROMPT,
  POLICY_INTRO,
  POLICY_NEVER_DO,
  POLICY_PLAN_FILE,
  POLICY_PLAN_LOCK,
  POLICY_REFACTOR_CLOSE,
  POLICY_REFACTOR_OPEN,
  POLICY_REMOVAL_CLOSE,
  POLICY_REMOVAL_OPEN,
  POLICY_REVIEW_COLD,
  POLICY_REVIEW_NITS,
  POLICY_ROLE_BOUNDARY,
  POLICY_TEST_GATE,
  POLICY_TEST_PROMPT,
} from "./delegate-policy";

const STOP = '`mimir_delegate` `action: "stop"`';
const RESUME = "`task` with its `task_id`";

const BODY = `${POLICY_INTRO}

${POLICY_PLAN_FILE}
2. Activate the coordinator role with the \`mimir_delegate\` tool: \`action: "start"\`, \`planFile: <that file>\`. From now until \`action: "stop"\` ${POLICY_PLAN_LOCK}

Worker models on OpenCode are baked into the agent files at install time — \`~/.mimir/config.json\` \`workerModels.opencode\` overlaid by \`[workers.models.opencode]\` in the user-level \`~/.mimir/mimir.toml\`. Re-run \`/mimir-install\` after changing them.

${POLICY_BRIEFS}

${PER_TASK_HEADING}

On OpenCode every worker runs in **this** directory — there is no worktree isolation — so run workers for one task **strictly one at a time**, and commit each accepted result before spawning the next.

At the **beginning of EACH task**, before dispatching or resuming any worker for it, call \`mimir_delegate\` with \`action: "task"\`. The host captures the task-start Git commit; verification and generated reviews include committed red tests plus implementation changes since that boundary. Do this once per task, even when reusing a worker from a previous task. **Do not call it again for retries, role assistance, or review fixes**, even when those use fresh workers. Repeated \`action: "start"\` for the same plan preserves the current boundary; \`status\` does not change it. A worker cannot be dispatched without a task boundary.

${POLICY_REFACTOR_OPEN} \`mimir_delegate\` with \`action: "task"\` and \`refactor: true\`. ${POLICY_REFACTOR_CLOSE}

1. **\`mimir-test\`** — \`task\` with \`subagent_type: "mimir-test"\`. ${POLICY_TEST_PROMPT} The task result carries the gate report appended ${POLICY_TEST_GATE} Commit as \`test(<package>): <task title>\`.
2. **\`mimir-impl\`** — \`subagent_type: "mimir-impl"\`. ${POLICY_IMPL_PROMPT} The result ${POLICY_IMPL_GATE} Run step 3 **before** committing.
3. **\`mimir-review\`** — \`task\` with \`subagent_type: "mimir-review"\` and exactly this prompt, nothing else:

   > Call \`mimir_review_prompt\` with title: "<task title>" and review the generated task diff and files, including committed red tests. You are reviewing cold — judge what is in front of you; do not ask what the plan was. Follow the generated instructions exactly: report only what you can show, with a trigger that can really happen. Do not edit anything. End with exactly one final line: STATUS: done

   ${POLICY_REVIEW_COLD} Confirmed blockers and should-fixes go back to \`mimir-impl\` by resuming it (${RESUME}) with the findings as the instruction. ${POLICY_REVIEW_NITS} Then commit the implementation, and each review fix, as §3 says.

${CHECKINS_HEADING}

- \`STATUS: question\` — resume the worker (${RESUME}) with the answer. ${POLICY_CHECKIN_ANSWER}
${POLICY_ROLE_BOUNDARY}
- Gate block — the result tells you the worker has stopped and which \`task_id\` to resume with the gate's reason as its instruction. Do that; after three blocks the gate marks the result \`STATUS: failed\`. That is your signal to escalate — do not respawn with the same prompt.
- Partial output (step limit reached), or a worker that died without a result (a rate limit, a crash): its edits are in this directory; check \`git status\`, then resume once with "continue". If it stalls again, stop and escalate.
${POLICY_FOLD_OPEN} \`mimir_delegate\` with \`action: "allow-deletion"\` and \`paths\`. ${POLICY_FOLD_CLOSE}
${POLICY_REMOVAL_OPEN} \`mimir_delegate\` with \`action: "allow-removal"\` and \`paths\`. ${POLICY_REMOVAL_CLOSE} On OpenCode every gate run judges the whole task from its base, so an allowance you grant for one worker's change still covers the next worker's gate.
${POLICY_ESCALATE_OPEN} the \`task_id\`, ${STOP}, ${POLICY_ESCALATE_CLOSE}

## 3. Commit subjects

${POLICY_CONVENTIONAL_COMMITS}

${POLICY_FINISH_OPEN}
2. ${STOP}.
${POLICY_FINISH_CLOSE}

${POLICY_NEVER_DO}`;

export const OPENCODE_DELEGATE = {
  frontmatter: [],
  body: BODY,
};
