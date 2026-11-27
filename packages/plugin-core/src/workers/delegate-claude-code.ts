/**
 * Claude Code's `/delegate` mechanics: the `mimir-cc` CLI, one git worktree
 * per worker, Agent-tool spawns and `SendMessage` resumes.
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

const ARGUMENT_HINT =
  'argument-hint: "<task description or path to a plan file>"';

const BODY = `${POLICY_INTRO}

${POLICY_PLAN_FILE}
2. Check \`git worktree list\` for leftover \`agent-*\` worktrees from an earlier run (a killed worker leaves its worktree behind). Remove each with \`git worktree remove <path>\` before you start — a stale one blocks nothing now, but its uncommitted changes are nobody's and will confuse collection later.
3. Activate the coordinator role: \`mimir-cc delegate start --plan <that file>\`. From now until \`delegate stop\` ${POLICY_PLAN_LOCK}
4. Coordinator state is keyed by session id. A resumed or forked session is a new id, so \`delegate status\` will report no active delegation — re-read the plan file and run \`delegate start\` again before spawning anything.

${POLICY_BRIEFS}

${PER_TASK_HEADING}

Before the red worker for **each new task**, run \`mimir-cc delegate task\` from the integration worktree. The host captures HEAD as the task base; there is no model-supplied base argument. Keep that boundary through red-test collection, implementation, retries, role assistance, and review fixes. Call \`delegate task\` again only when moving to the next task. Starting the same plan again preserves its task boundary; a different plan clears it. A failed capture clears the prior boundary and blocks workers until capture succeeds. Only Mimir's workers need a boundary — utility agents (Explore, docs lookups) spawn without one.

${POLICY_REFACTOR_OPEN} \`mimir-cc delegate task --refactor\`. ${POLICY_REFACTOR_CLOSE}

Each task runs three workers in order, each in its own worktree branched from the current HEAD, so **merge each worker's result before spawning the next** or the next one won't see it. Run tasks sequentially: the session has one active task boundary. A worker's worktree gets its dependencies installed by the role guard on the worker's first tool call (Bun projects) — you do not need to tell it to install anything.

\`delegate start\` prints a \`worker models:\` line — the per-role models from \`~/.mimir/config.json\` overlaid by \`[workers.models.claudeCode]\` in the layered \`mimir.toml\` (user, then this project). When it names a model for a role (\`impl=opus\`), pass that value as the Agent tool's \`model\` parameter on every spawn of that role. When the line reads \`default (same model for every role)\`, or names no model for the role you are spawning, omit \`model\` — the worker runs on your model. \`delegate status\` prints the same line while the delegation is active, so you can recover it mid-run.

1. **\`mimir-test\`** — spawn with \`subagent_type: "mimir-test"\`. ${POLICY_TEST_PROMPT} Its hand-back carries the gate report ${POLICY_TEST_GATE} Collect its worktree (§3), commit on the integration branch.
2. **\`mimir-impl\`** — \`subagent_type: "mimir-impl"\`. ${POLICY_IMPL_PROMPT} Its hand-back ${POLICY_IMPL_GATE} Then, **before collecting** (the reviewer reads the worktree), run step 3.
3. **\`mimir-review\`** — spawn with \`subagent_type: "mimir-review"\` and exactly this prompt, nothing else:

   > Review the change in the worktree at \`<worktreePath>\`. That is not the directory you start in, and you do not need to \`cd\` into it: run \`mimir-cc review-prompt <worktreePath> --title "<task title>"\` from where you are and follow its instructions exactly. It gives you the task diff (committed red tests plus implementation, excluding the active plan), and you read the files yourself, by their paths under \`<worktreePath>\`. Keep the coordinator's \`CLAUDE_CODE_SESSION_ID\` so the command uses the active task boundary.

   ${POLICY_REVIEW_COLD} Confirmed blockers and should-fixes go back to \`mimir-impl\` by resuming it (\`SendMessage\` to its agent id) with the findings as the instruction, or to a fresh impl worker if the original's worktree is already collected; re-run the gate via a fresh hand-back. ${POLICY_REVIEW_NITS}

${CHECKINS_HEADING}

- \`STATUS: question\` — answer it with \`SendMessage\` to the worker's agent id; it resumes with full context. ${POLICY_CHECKIN_ANSWER}
${POLICY_ROLE_BOUNDARY}
- Partial output (\`maxTurns\` reached): resume once with "continue". If it stalls again, stop and escalate.
- **A worker that died** (a task notification with no hand-back — a rate limit, a crash): its worktree is retained with whatever it had written. Check \`git -C <worktreePath> status\`, then resume it by agent id with "continue"; it picks up from its transcript.
- **Stale base**: a worker whose gate fails on code that landed on the integration branch after it was spawned (a review fix merged while it was still working) is not wrong — merge the integration tip forward into its branch (\`git -C <worktreePath> merge <integration-branch>\`) and resume it to hand back again.
- Gate block: the worker retries on its own with the gate's reason; after three blocks the gate lets it stop with \`STATUS: failed\`. If the third block was the worker's own doing, escalate — do not respawn with the same prompt. If it was exogenous (a flaky test, a stale base you have since fixed), re-run the gate yourself: \`mimir-cc verify --worktree <worktreePath> --agent <agentId>\` prints the same report and clears the loop guard on a pass.
${POLICY_FOLD_OPEN} \`mimir-cc delegate allow-deletion <path>...\`. ${POLICY_FOLD_CLOSE}
${POLICY_REMOVAL_OPEN} \`mimir-cc delegate allow-removal <path>...\`. ${POLICY_REMOVAL_CLOSE}
${POLICY_ESCALATE_OPEN} the worker transcript path, \`mimir-cc delegate stop\`, ${POLICY_ESCALATE_CLOSE}
- Run one task at a time; never advance its boundary while a worker or review fix for it is still in flight.

## 3. Collecting a worker's result

A worker's worktree is **retained** after it finishes when it holds uncommitted changes — the Agent result gives you \`worktreePath\` and \`worktreeBranch\`. For each accepted hand-back, once its review is done:

\`\`\`bash
git -C <worktreePath> add -A && git -C <worktreePath> commit -m "<type>(<scope>): <task title>"
git merge --no-ff <worktreeBranch>          # onto your integration branch
git worktree remove <worktreePath> && git branch -d <worktreeBranch>
\`\`\`

${POLICY_CONVENTIONAL_COMMITS}

\`-d\`, never \`-D\`: the guard denies a force-delete for every role. If \`-d\` refuses, the branch holds commits your merge didn't take — stop and find out why rather than forcing it. Resolve conflicts yourself only in the merge; never edit source files directly.

After collecting each task, run the integration check on the merged tree — \`mimir-cc verify --worktree <repo root> --allow-empty\` uses the active task base, runs the project's full toolchain, and prints the report (a worker cannot opt into an empty change set). A worker's gate judges only what that worker changed. This run judges the whole task from its base, with the task's allowances applied and listed in its report, so it is where a merge that dropped tests shows up. Do this before advancing to the next task boundary. Integration is where individually-passing work breaks.

${POLICY_FINISH_OPEN}
2. \`mimir-cc delegate stop\`.
${POLICY_FINISH_CLOSE}

${POLICY_NEVER_DO}`;

export const CLAUDE_CODE_DELEGATE = {
  frontmatter: [ARGUMENT_HINT],
  body: BODY,
};
