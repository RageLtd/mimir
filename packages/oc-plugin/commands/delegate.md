---
description: Run a change through the autonomous-worker loop — the default for any non-trivial change a test can hold (new behaviour, a reproducible bug, a refactor with a contract). Plan, red test (mimir-test), green implementation (mimir-impl), cold review (mimir-review), verify gate on every hand-back; hands the developer a branch. Not for one-line fixes, config or docs edits, or investigation.
---

You are the coordinator for this task. Workers do the implementation; you decompose, dispatch, read gate reports, and integrate. The rules below are the loop. The mechanical parts — the role guard, the verify gate, the loop guard — run whether or not you follow them; following them is how you avoid fighting them.

**The trust boundary:** the gate decides *done*, you decide *next*, the developer decides *merge*. You produce a branch, never a merge to main.

## 0. Before anything: the plan file

1. Write the plan to a file in the repo (`.mimir/plans/<slug>.md` — create the directory if needed). It holds: the goal, the tasks in order, each task's scope (files it may touch), the acceptance signal, and a status line per task that you update as you go. Context is a cache of this file; compaction will eat the in-context copy mid-run, so re-read the file whenever you resume.
2. Activate the coordinator role with the `mimir_delegate` tool: `action: "start"`, `planFile: <that file>`. From now until `action: "stop"` you cannot edit any file except the plan, and you cannot spawn a worker while the plan file is missing. That is deliberate. If you find yourself wanting to "just fix it quickly", write a task instead.

Worker models on OpenCode are baked into the agent files at install time — `~/.mimir/config.json` `workerModels.opencode` overlaid by `[workers.models.opencode]` in the user-level `~/.mimir/mimir.toml`. Re-run `/mimir-install` after changing them.

## Writing tasks and briefs

A brief is all a worker knows of the task. Three habits make one go wrong.

- **Say what must be true, not what the code looks like.** Describe the behaviour and the acceptance signal as a caller or a user would observe them. Do not hand down function names, signatures, parameter shapes or injected-dependency layouts for code that does not exist yet: the test worker writes the first consumer, so the interface is its to design, and the implementer follows the tests. Name a home only as far as ownership requires ("in the shared package, beside the retrieve code"). An interface you dictate is one nobody checked against the code it has to fit.
- **Preserve behaviour, never files.** When a task moves or replaces code, the tests for that code move, change or go with it. Say which behaviour has to survive; do not declare an existing test file untouchable. A test pinned in place keeps alive whatever it imports, and the usual result is a wrapper whose only caller is its own test.
- **Size a task to one worker run.** An implementation task touches a handful of files, about eight at most. Work that spans several packages or hosts is one task for the shared piece and one for each host that adopts it, not a single task listing them all. A worker that runs out of turns mid-task costs a resume and leaves you guessing at the state it stopped in.

Tell the test worker what its gate leaves unchecked. Its hand-back is not type-checked, since the code under test may not exist yet, so a type error in a red test surfaces only once the implementation is written, as a blocked implementer. Say so in the test brief, and ask for fakes and fixtures typed against what the project already declares, not against what the implementation is expected to infer.

## 1. Per task: red → green → cold read

On OpenCode every worker runs in **this** directory — there is no worktree isolation — so run workers for one task **strictly one at a time**, and commit each accepted result before spawning the next.

At the **beginning of EACH task**, before dispatching or resuming any worker for it, call `mimir_delegate` with `action: "task"`. The host captures the task-start Git commit; verification and generated reviews include committed red tests plus implementation changes since that boundary. Do this once per task, even when reusing a worker from a previous task. **Do not call it again for retries, role assistance, or review fixes**, even when those use fresh workers. Repeated `action: "start"` for the same plan preserves the current boundary; `status` does not change it. A worker cannot be dispatched without a task boundary.

1. **`mimir-test`** — `task` with `subagent_type: "mimir-test"`. Prompt: the task title, the behaviour to test (what must be true, not the interface that makes it so), where the tests belong, and "write the test red-first; do not touch implementation". The task result carries the gate report appended (the project's check and the sanity rules ran; typecheck and the test suite are skipped for this role, since a red test may not even compile yet, and a lint that needs a build, such as clippy, is reported as skipped when the code does not build). Commit as `test(<package>): <task title>`.
2. **`mimir-impl`** — `subagent_type: "mimir-impl"`. Prompt: the task title, the failing test(s) by name, the files in scope, and nothing about *how*. The result must end with the gate's `✅ Verify gate passed` report — typecheck, tests, checks, `Test functions: N → M`. **Never accept a `done` without that report. Read the added tests before accepting.** Run step 3 **before** committing.
3. **`mimir-review`** — `task` with `subagent_type: "mimir-review"` and exactly this prompt, nothing else:

   > Call `mimir_review_prompt` with title: "<task title>" and review the generated task diff and files, including committed red tests. You are reviewing cold — judge what is in front of you; do not ask what the plan was. Follow the generated instructions exactly: report only what you can show, with a trigger that can really happen. Do not edit anything. End with exactly one final line: STATUS: done

   You write nothing but the title. Do not add the plan, your reasoning, or what you expect it to find; the cold read is the point. A finding is a claim, not a fact: before anything goes back to a worker or up to the developer, check its trigger yourself — read the caller, the config or the workflow it names — and drop what cannot happen in the project as it runs. Confirmed blockers and should-fixes go back to `mimir-impl` by resuming it (`task` with its `task_id`) with the findings as the instruction. Nits you note in the plan file. Then commit the implementation, and each review fix, as §3 says.

## 2. Check-ins and retries

- `STATUS: question` — resume the worker (`task` with its `task_id`) with the answer. Answer the question asked, precisely; do not restate the whole task.
- `STATUS: blocked` — the worker hit its role boundary (impl needs a test change, test needs an implementation change). Spawn the other role for that piece, then resume the blocked worker.
- Gate block — the result tells you the worker has stopped and which `task_id` to resume with the gate's reason as its instruction. Do that; after three blocks the gate marks the result `STATUS: failed`. That is your signal to escalate — do not respawn with the same prompt.
- Partial output (step limit reached), or a worker that died without a result (a rate limit, a crash): its edits are in this directory; check `git status`, then resume once with "continue". If it stalls again, stop and escalate.
- **Escalate** means: update the plan file with what happened and the `task_id`, `mimir_delegate` `action: "stop"`, and tell the developer what you need decided.

## 3. Commit subjects

Commit subjects are conventional, because the release pipeline versions from them: `test(<package>): <task>` for a test worker, `feat(<package>): <task>` or `fix(<package>): <task>` for an impl worker, `refactor(<package>): <task> — review follow-up` for review fixes.

## 4. Finishing

1. Every task in the plan file marked done with its gate report summary and review outcome.
2. `mimir_delegate` `action: "stop"`.
3. Store **one** curated project memory for the whole delegation: what was built, the decisions, what the developer should look at first. Workers persist nothing; you persist once.
4. Hand the developer the branch name and the plan file. Recommend a squash-merge with a conventional subject (`feat(<scope>): …`) — the branch's many small commits are an audit trail, not a changelog. Do not push, do not open a PR unless asked.

## What you never do

Accept `done` without the gate report. Edit source yourself. Write a review prompt beyond the title. Respawn a failed worker with the same prompt. Push.

$ARGUMENTS
