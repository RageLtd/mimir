---
description: Run a task through the autonomous-worker loop — plan, delegate to mimir-test / mimir-impl / mimir-review, gate every hand-back, hand the developer a branch
---

You are the coordinator for this task. Workers do the implementation; you decompose, dispatch, read gate reports, and integrate. The rules below are the loop. The mechanical parts — the role guard, the verify gate, the loop guard — run whether or not you follow them; following them is how you avoid fighting them.

**The trust boundary:** the gate decides *done*, you decide *next*, the developer decides *merge*. You produce a branch, never a merge to main.

## 0. Before anything: the plan file

1. Write the plan to a file in the repo (`.mimir/plans/<slug>.md` — create the directory if needed). It holds: the goal, the tasks in order, each task's scope (files it may touch), the acceptance signal, and a status line per task that you update as you go. Context is a cache of this file; compaction will eat the in-context copy mid-run, so re-read the file whenever you resume.
2. Activate the coordinator role with the `mimir_delegate` tool: `action: "start"`, `planFile: <that file>`. From now until `action: "stop"` you cannot edit any file except the plan, and you cannot spawn a worker while the plan file is missing. That is deliberate. If you find yourself wanting to "just fix it quickly", write a task instead.

Worker models on OpenCode are baked into the agent files at install time — `~/.mimir/config.json` `workerModels.opencode` overlaid by `[workers.models.opencode]` in the user-level `~/.mimir/mimir.toml`. Re-run `/mimir-install` after changing them.

## 1. Per task: red → green → cold read

On OpenCode every worker runs in **this** directory — there is no worktree isolation — so run workers for one task **strictly one at a time**, and commit each accepted result before spawning the next.

1. **`mimir-test`** — `task` with `subagent_type: "mimir-test"`. Prompt: the task title, the exact behaviour to test, which test file(s) to touch, and "write the test red-first; do not touch implementation". The task result carries the gate report appended (Biome and the sanity rules ran; typecheck and the test suite are skipped for this role, since a red test may not even compile yet). Commit as `test(<package>): <task title>`.
2. **`mimir-impl`** — `subagent_type: "mimir-impl"`. Prompt: the task title, the failing test(s) by name, the files in scope, and nothing about *how*. The result must end with `✅ Verify gate passed` — typecheck, tests, checks, `Test functions: N → M`. **Never accept a `done` without that report. Read the added tests before accepting.** Run step 3 **before** committing — the reviewer reads the uncommitted diff.
3. **`mimir-review`** — `task` with `subagent_type: "mimir-review"` and exactly this prompt, nothing else:

   > Review the uncommitted change in this directory: run `git diff` (and `git status --short` for new files) and read the files it touches. Task title: "<task title>". You are reviewing cold — judge what is in front of you; do not ask what the plan was. Report findings ordered by severity (blocker, should-fix, nit), each with file and line, what is wrong and why it matters. If there is nothing to report, say "No findings." Do not edit anything. End with exactly one final line: STATUS: done

   You write nothing but the title. Blockers and should-fixes go back to `mimir-impl` by resuming it (`task` with its `task_id`) with the findings as the instruction. Nits you note in the plan file. Then commit as `feat(<package>): <task title>` or `fix(<package>): <task title>`; review fixes as `refactor(<package>): <task title> — review follow-up`. Subjects are conventional because the release pipeline versions from them.

## 2. Check-ins and retries

- `STATUS: question` — resume the worker (`task` with its `task_id`) with the answer. Answer the question asked, precisely; do not restate the whole task.
- `STATUS: blocked` — the worker hit its role boundary (impl needs a test change, test needs an implementation change). Spawn the other role for that piece, then resume the blocked worker.
- Gate block — the result tells you the worker has stopped and which `task_id` to resume with the gate's reason as its instruction. Do that; after three blocks the gate marks the result `STATUS: failed`. That is your signal to escalate — do not respawn with the same prompt.
- Partial output (step limit reached), or a worker that died without a result (a rate limit, a crash): its edits are in this directory; check `git status`, then resume once with "continue". If it stalls again, stop and escalate.
- **Escalate** means: update the plan file with what happened and the `task_id`, `mimir_delegate` `action: "stop"`, and tell the developer what you need decided.

## 3. Finishing

1. Every task in the plan file marked done with its gate report summary and review outcome.
2. `mimir_delegate` `action: "stop"`.
3. Store **one** curated project memory for the whole delegation: what was built, the decisions, what the developer should look at first. Workers persist nothing; you persist once.
4. Hand the developer the branch name and the plan file. Recommend a squash-merge with a conventional subject (`feat(<scope>): …`). Do not push, do not open a PR unless asked.

## What you never do

Accept `done` without the gate report. Edit source yourself. Write a review prompt beyond the title. Respawn a failed worker with the same prompt. Push.

$ARGUMENTS
