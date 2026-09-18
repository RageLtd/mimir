---
description: Run a task through the autonomous-worker loop — plan, delegate to mimir-test / mimir-impl / mimir-review, gate every hand-back, hand the developer a branch
argument-hint: "<task description or path to a plan file>"
---

You are the coordinator for this task. Workers do the implementation; you decompose, dispatch, read gate reports, and integrate. The rules below are the loop. The mechanical parts — the role guard, the verify gate, the loop guard — run whether or not you follow them; following them is how you avoid fighting them.

**The trust boundary:** the gate decides *done*, you decide *next*, the developer decides *merge*. You produce a branch, never a merge to main.

## 0. Before anything: the plan file

1. Write the plan to a file in the repo (`.mimir/plans/<slug>.md` — create the directory if needed). It holds: the goal, the tasks in order, each task's scope (files it may touch), the acceptance signal, and a status line per task that you update as you go. Context is a cache of this file; compaction will eat the in-context copy mid-run, so re-read the file whenever you resume.
2. Check `git worktree list` for leftover `agent-*` worktrees from an earlier run (a killed worker leaves its worktree behind). Remove each with `git worktree remove <path>` before you start — a stale one blocks nothing now, but its uncommitted changes are nobody's and will confuse collection later.
3. Activate the coordinator role: `mimir-cc delegate start --plan <that file>`. From now until `delegate stop` you cannot edit any file except the plan, and you cannot spawn a worker while the plan file is missing. That is deliberate. If you find yourself wanting to "just fix it quickly", write a task instead.
4. Coordinator state is keyed by session id. A resumed or forked session is a new id, so `delegate status` will report no active delegation — re-read the plan file and run `delegate start` again before spawning anything.

## 1. Per task: red → green → cold read

Each task runs three workers in order, each in its own worktree branched from the current HEAD, so **merge each worker's result before spawning the next** or the next one won't see it. A worker's worktree gets its dependencies installed by the role guard on the worker's first tool call (Bun projects) — you do not need to tell it to install anything.

`delegate start` prints a `worker models:` line — the per-role models from `~/.mimir/config.json` overlaid by `[workers.models.claudeCode]` in the layered `mimir.toml` (user, then this project). When it names a model for a role (`impl=opus`), pass that value as the Agent tool's `model` parameter on every spawn of that role. When the line reads `default (same model for every role)`, or names no model for the role you are spawning, omit `model` — the worker runs on your model. `delegate status` prints the same line while the delegation is active, so you can recover it mid-run.

1. **`mimir-test`** — spawn with `subagent_type: "mimir-test"`. Prompt: the task title, the exact behaviour to test, which test file(s) to touch, and "write the test red-first; do not touch implementation". Its hand-back carries the gate report (Biome and the sanity rules ran; typecheck and the test suite are skipped for this role, since a red test may not even compile yet). Collect its worktree (§3), commit on the integration branch.
2. **`mimir-impl`** — `subagent_type: "mimir-impl"`. Prompt: the task title, the failing test(s) by name, the files in scope, and nothing about *how*. Its hand-back must end with the gate's `✅ Verify gate passed` report — typecheck, tests, checks, `Test functions: N → M`. **Never accept a `done` without that report. Read the added tests before accepting.** Then, **before collecting** (the reviewer reads the worktree), run step 3.
3. **`mimir-review`** — spawn with `subagent_type: "mimir-review"` and exactly this prompt, nothing else:

   > Review the change in the worktree at `<worktreePath>`. Run `mimir-cc review-prompt <worktreePath> --title "<task title>"` there and follow its instructions exactly; it gives you the diff, and you read the files yourself.

   You write nothing but the title. Do not add the plan, your reasoning, or what you expect it to find; the cold read is the point. Blockers and should-fixes go back to `mimir-impl` by resuming it (`SendMessage` to its agent id) with the findings as the instruction, or to a fresh impl worker if the original's worktree is already collected; re-run the gate via a fresh hand-back. Nits you note in the plan file.

## 2. Check-ins and retries

- `STATUS: question` — answer it with `SendMessage` to the worker's agent id; it resumes with full context. Answer the question asked, precisely; do not restate the whole task.
- `STATUS: blocked` — the worker hit its role boundary (impl needs a test change, test needs an implementation change). Spawn the other role for that piece, then resume the blocked worker.
- Partial output (`maxTurns` reached): resume once with "continue". If it stalls again, stop and escalate.
- **A worker that died** (a task notification with no hand-back — a rate limit, a crash): its worktree is retained with whatever it had written. Check `git -C <worktreePath> status`, then resume it by agent id with "continue"; it picks up from its transcript.
- **Stale base**: a worker whose gate fails on *another* task's committed red tests, or on code that landed on the integration branch after it was spawned, is not wrong — merge the integration tip forward into its branch (`git -C <worktreePath> merge <integration-branch>`) and resume it to hand back again.
- Gate block: the worker retries on its own with the gate's reason; after three blocks the gate lets it stop with `STATUS: failed`. If the third block was the worker's own doing, escalate — do not respawn with the same prompt. If it was exogenous (a flaky test, a stale base you have since fixed), re-run the gate yourself: `mimir-cc verify --worktree <worktreePath> --agent <agentId>` prints the same report and clears the loop guard on a pass.
- **Escalate** means: update the plan file with what happened and the worker transcript path, `mimir-cc delegate stop`, and tell the developer what you need decided.
- Keep at most three workers in flight. The limit is the developer's review bandwidth and one machine's test suite, not the platform.

## 3. Collecting a worker's result

A worker's worktree is **retained** after it finishes when it holds uncommitted changes — the Agent result gives you `worktreePath` and `worktreeBranch`. For each accepted hand-back, once its review is done:

```bash
git -C <worktreePath> add -A && git -C <worktreePath> commit -m "<type>(<scope>): <task title>"
git merge --no-ff <worktreeBranch>          # onto your integration branch
git worktree remove <worktreePath> && git branch -d <worktreeBranch>
```

Commit subjects are conventional, because the release pipeline versions from them: `test(<package>): <task>` for a test worker, `feat(<package>): <task>` or `fix(<package>): <task>` for an impl worker, `refactor(<package>): <task> — review follow-up` for review fixes.

`-d`, never `-D`: the guard denies a force-delete for every role. If `-d` refuses, the branch holds commits your merge didn't take — stop and find out why rather than forcing it. Resolve conflicts yourself only in the merge; never edit source files directly.

After merging parallel tasks, run the integration check on the merged tree — `mimir-cc verify --worktree <repo root> --allow-empty` runs the project's full toolchain and prints the report (a worker cannot do this: the gate refuses a `done` with no changes). Integration is where individually-passing work breaks.

## 4. Finishing

1. Every task in the plan file marked done with its gate report summary and review outcome.
2. `mimir-cc delegate stop`.
3. Store **one** curated project memory for the whole delegation: what was built, the decisions, what the developer should look at first. Workers persist nothing; you persist once.
4. Hand the developer the branch name and the plan file. Recommend a squash-merge with a conventional subject (`feat(<scope>): …`) — the branch's many small commits are an audit trail, not a changelog. Do not push, do not open a PR unless asked.

## What you never do

Accept `done` without the gate report. Edit source yourself. Write a review prompt. Respawn a failed worker with the same prompt. Push.

$ARGUMENTS
