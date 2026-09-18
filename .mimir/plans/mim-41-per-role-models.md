# MIM-41 — Per-role model configuration

Branch: `mim-41-per-role-models` (from main 65d0527). Coordinator: this session.
Ticket: https://linear.app/mimir-server/issue/MIM-41

## Goal

A developer can pick a different model per worker role (`impl`, `test`, `review`)
with a config edit, no code change. Default stays "same model for every role"
(Rage, 2026-09-17). The one intended use is a *different* model on `mimir-review`
for a stronger cold read.

## Design (decided with Rage, 2026-09-18)

`~/.mimir/config.json` gains one optional key:

```json
"workerModels": {
  "claudeCode": { "impl": "opus", "test": "sonnet", "review": "fable" },
  "opencode":   { "review": "anthropic/claude-opus-4" }
}
```

- Two host namespaces because the value formats differ: Claude Code's Agent tool
  takes a tier (`sonnet | opus | haiku | fable`); OpenCode agent frontmatter takes
  `provider/id`. Every key optional; a missing role means "no override".
- **Claude Code**: the worker `.md` files ship static inside the plugin, so the
  model cannot be rendered into them. Instead `mimir-cc delegate start|status`
  prints the role→model map and the `/delegate` playbook tells the coordinator to
  pass `model` on each Agent spawn. No user-level agent files (plugin stays the
  single source).
- **OpenCode**: the installer already renders `~/.config/opencode/agents/mimir-*.md`;
  it adds a `model: <provider/id>` frontmatter line for roles that have one.
- No env overrides (config-only, per ticket). No UI.

## Tasks

### T0 — make plugin-core's stub-server tests deterministic under `--parallel` (prerequisite, added 2026-09-18) — status: pending

Why: the gate fails closed on any test failure, and `brain/{extract,embedder}.test.ts`
flake ~1 in 3 under `bun test --parallel` (14 workers). Two mechanisms:
(a) the runner's 5s default per-test timeout vs a starved loopback stub round-trip
(extract's own fetch timeout is 60s); (b) `embedder.ts` `HEALTH_TIMEOUT_MS = 1_500`
is hard-coded — a starved `/health` probe reads as "not running" → "not installed"
→ null. `backfill.ts` → `embedTexts` carries (b) latently.

Scope (impl): `packages/plugin-core/src/brain/embedder.ts` only — `getOrStartEmbedder`,
`embedTexts`, `createEmbedQuery` accept an optional `healthTimeoutMs` (default stays
1_500 for hooks). Tests: `brain/embedder.test.ts` (new option, delayed-health case,
stub-backed cases pass a generous value) and `setDefaultTimeout(30_000)` at the top
of the six `Bun.serve` stub test files: `brain/{backfill,hygiene,summarize,
embedder-install,extract,embedder}.test.ts`.

Acceptance: `bun run test` in plugin-core green 5× in a row; gate report on impl.

### T1 — shared config: `workerModels` field + resolver (plugin-core) — status: pending

Scope (impl may touch): `packages/plugin-core/src/shared-config.ts`.
Tests: `packages/plugin-core/src/shared-config.test.ts`.

Behaviour:
- `MimirConfig.workerModels?: { claudeCode?: WorkerModels; opencode?: WorkerModels }`
  where `WorkerModels = { impl?: string; test?: string; review?: string }`
  (readonly throughout, matching the file's style).
- `readConfig` round-trips the field; drops non-string or empty entries and drops
  a namespace/the whole key when nothing survives (mirrors `optionalString`).
- New export `workerModelsFor(config: MimirConfig | null, host: "claudeCode" | "opencode")`
  → `WorkerModels` (empty object when unset).

Acceptance: new tests red then green; typecheck + check clean.

### T2 — Claude Code: report the map + playbook passes `model` (cc-plugin) — status: pending

Depends on T1 merged.
Scope: `packages/cc-plugin/src/delegate-command.ts`, `packages/cc-plugin/commands/delegate.md`,
`packages/cc-plugin/README.md` (config key doc line).
Tests: `packages/cc-plugin/src/delegate-command.test.ts`.

Behaviour:
- A pure, exported `formatWorkerModels(models: WorkerModels)` → one line:
  `worker models: impl=opus test=sonnet review=fable` listing only set roles, or
  `worker models: default (same model for every role)` when none set.
- `delegate start` and `delegate status` (when active) print that line after the
  plan line, reading `workerModelsFor(await readConfig(), "claudeCode")`.
- `commands/delegate.md` §1: when `delegate start` reports a model for a role,
  pass it as the Agent tool's `model` for that role's spawns; otherwise omit.
- README: document `workerModels` under the config section.

Acceptance: tests red→green; gate report; review clean.

### T3 — OpenCode: `model:` frontmatter from config (oc-plugin) — status: pending

Depends on T1 merged. Can run in parallel with T2.
Scope: `packages/oc-plugin/src/config.ts` (mirror the field — this file is the
deliberate duplicate of shared-config), `packages/oc-plugin/src/agents.ts`,
`packages/oc-plugin/src/install.ts` (pass `mimirConfig.workerModels?.opencode`),
`packages/oc-plugin/README.md` (config key doc line).
Tests: `packages/oc-plugin/src/config.test.ts`, `packages/oc-plugin/src/agents.test.ts`.

Behaviour:
- `readConfig` in oc-plugin round-trips `workerModels` with the same normalisation
  as T1.
- `renderWorkerFrontmatter(worker, model?)` emits `model: <id>` (JSON-quoted like
  `description`) directly after `mode: subagent` when `model` is set; no line otherwise.
- `renderWorkerAgents(promptMarkdown, models: WorkerModels = {})` passes
  `models[worker.role]` per worker.
- install.ts passes the opencode namespace from the loaded config.

Acceptance: tests red→green; gate report; review clean.

### T4 — post-merge gate — status: pending

No-op `mimir-impl` on the merged tree ("run the suite, change nothing").

## MERGE NOTE — squash-merge (Rage's call): the worker-collection commits are not conventional, so squash to main with a `feat:` subject so the release scripts minor-bump, e.g. `feat(workers): per-role worker models via config.json + mimir.toml (MIM-41)` with a body naming the gate fixes (branch coverage, [verify] table, test role skips typecheck) and the T0 hermetic-test work.

## DONE (2026-09-18) — branch `mim-41-per-role-models` @ 294ea0e, ready for Rage's review

All tasks complete: T0 (hermetic stub tests + healthTimeoutMs), T1 (workerModels config + workerModelsFor + formatWorkerModels in plugin-core), T2 (Claude Code: delegate start/status print the map; playbook passes `model` per spawn; README), T3 (OpenCode: config shim over plugin-core, `model:` frontmatter, installer wiring; README), T4 (post-merge check by hand: typecheck 6/6, full workspace suite green, Biome clean). Every impl cold-reviewed; all should-fixes landed. Not pushed. Read first: `packages/plugin-core/src/shared-config.ts` (the schema + resolver), then `packages/cc-plugin/commands/delegate.md` §1 and `packages/oc-plugin/src/agents.ts`. After merge to main: cut cc-plugin + oc-plugin releases, `rm ~/.mimir/.cc-dev && ~/.mimir/ensure-binary.sh`, set `workerModels.claudeCode` to opus×3 in `~/.mimir/config.json`.

## (superseded) RESUME HERE (session ended on token budget, 2026-09-18)

Branch `mim-41-per-role-models` at 6601252 (T1 impl fe5149c, T0 tests 0f0eaa6, T0 impl 6601252 all merged; gate fix 77cf01e merged in). Dev gate binary installed (`~/.mimir/.cc-dev` pinned).

State per task:
- T0: impl merged, gate passed. Cold review NOT yet run — prompt saved at scratchpad `review-t0.md` (regenerate if the scratchpad is gone: the diff is `git show eba9c84`). Next: spawn mimir-review with that prompt verbatim.
- T1: impl + review done; review follow-ups IN FLIGHT when the session ended — two workers may have retained worktrees under `.claude/worktrees/` (check `git worktree list`): a mimir-impl freezing `NO_WORKER_MODELS` + doc-comment nits in `shared-config.ts`, and a mimir-test adding "non-record shapes are dropped" to `shared-config.test.ts`. Collect each (read diff → commit in worktree → `git merge --no-ff` → `git worktree remove` → `git branch -d`), verifying the impl one's gate report in its transcript (`tasks/<id>.output` under the session scratchpad) or by hand-driving `mimir-cc verify` with its agent id. Stale worktrees with no changes: just remove.
- T2, T3, T4: not started. Plan sections above are current. T2/T3 can run in parallel after collection; T4 no-op gate last.

Then: `mimir-cc delegate start --plan .mimir/plans/mim-41-per-role-models.md` in the new session (state is session-keyed) before spawning anything.

## Issues found during this delegation (the loop's own bugs — all need fixing)

Status: FIXED = landed on a branch; OPEN = needs a ticket/fix after this run.

**Inline fix batch (2026-09-18, on this branch, Rage-approved):** closes #7 (guard hook bootstraps a worker worktree's node_modules once — `worktree-bootstrap.ts`), #10 + #29 (`mimir-cc verify --worktree <path> [--role] [--agent] [--allow-empty]` CLI mode; `allowEmpty` runs the project root's toolchain as the integration check), #11 (a gate run with zero commands blocks), #12 (edit-guard: fan-out writing only to scratch paths is not an edit; a `$var` target still is), #13 (`cartographer_file_info` says "file_path is required"), #14/#15/#20/#22/#26/#29/#30 (both playbooks rewritten: no `run_in_background`, review before collection with the reviewer fetching its own prompt, stale-base merge-forward, worker-died resume, conventional collection commits, squash-merge advice, integration check via the CLI), #16/#19 (`typescript` is a root devDependency — `bunx tsc` resolves locally, no per-spawn fetch), #18 (single `WorkerRole`, in shared-config), #21 (worker contract: `>|` and log-then-read), #23 (verify hook no-ops when the payload's cwd no longer exists), #25 (moot with #7), #27 (per-package typecheck via `tests/typecheck.ts <pkg>` with all-packages fallback; `[verify]` passes `basename $PWD`). Also: `CLAUDE_CODE_SUBAGENT_MODEL=opus` in the settings template so no subagent inherits the coordinator's model by default; `review-prompt` no longer inlines file bodies. Still OPEN: #28 (mutation-sensitivity primitive — separate ticket), #17 (upstream rules pack).

1. FIXED (v1.4.5) — Claude Code reports plugin-shipped agents as `mimir-cc:mimir-test` in hook payloads; `workerByName` exact-matched → role guard silent, verify gate fell to `impl`. `bareName()` in `workers/roles.ts`.
2. FIXED (77cf01e) — Coverage check only saw the worker's worktree diff; red tests committed first on the integration branch made every impl diff source-only → blocked by construction. `ChangeSet.branchPaths` + `coverageCheck(files, branchPaths)`.
3. FIXED (77cf01e) — No `[verify]` table → resolver fell to package.json scripts → only `test` ever ran; typecheck/lint never ran in this repo (test-role reports showed `Commands: (none)` and nobody noticed). Repo `mimir.toml`.
4. FIXED (77cf01e) — `bunx tsc -p tsconfig.json` from the repo root uses the base tsconfig (no include/DOM) and sweeps server browser files. Typecheck routed through the root script from any root.
5. FIXED (77cf01e) — A retained worker worktree's `biome.json` is a nested root → `bun run check` fails in the main worktree while any worker worktree exists. `biome.json` excludes `.claude/worktrees`.
6. FIXED (77cf01e) — `.claude/worktrees/` was not gitignored.
7. OPEN — Worker worktrees start without `node_modules`; every worker must `bun install --frozen-lockfile` before it can verify anything (each burned turns discovering this). Needs a worktree-setup step (CC worktree hook, or the gate/guard bootstrapping) or at least a playbook line in the worker prompt.
8. IN PROGRESS (T0) — plugin-core suite flakes ~1 in 3 under `bun test --parallel` (14 workers): HTTP-stub tests vs the runner's 5s default timeout, and `embedder.ts` hard-coded 1.5s `/health` probe. Gate fails closed on any flake.
9. OPEN — Red-first commits that add new API surface break the workspace typecheck for EVERY later worker's gate until the impl lands (T0's test worker was blocked on T1's red tests). Design question: test-role typecheck scoped to the worker's own files/package, or the playbook forbids landing red tests that don't typecheck (the worker used a typed-variable trick to keep typecheck green — brittle), or sequence: never run a second task's workers while a task sits between red and green.
10. OPEN — Loop guard exhausted by an exogenous flake → worker forced to `STATUS: failed`; no coordinator primitive to re-run the gate. Workaround used: hand-driven `MIMIR_ACTIVE=1 mimir-cc verify < payload.json` with the worker's agent id. Wants `mimir-cc verify --worktree <path> --agent <id>` (or `delegate gate`) and a loop-guard reset on pass that the coordinator can invoke deliberately.
11. OPEN — A gate pass with `Commands: (none)` should be loud (or a block): a "pass" that ran no toolchain is worth nothing — exactly the fail-closed principle the resolver already applies to unresolved roots.
12. OPEN — cc-plugin `edit-guard` false positives: a shell `for` loop with per-iteration `>` redirects, and `rm -f` + `>>` into one scratch file, both denied as "bulk edits across many paths". Redirects to the scratchpad are not source edits.
13. OPEN — `cartographer_file_info` (mimir-local) returns `File not found: ""` for both repo-relative and absolute paths (`packages/server/src/routes/mcp.ts`).
14. OPEN — Playbook says spawn workers with `run_in_background: false`; the Agent tool in this session has no such parameter (always background). Doc mismatch in `commands/delegate.md`.
15. OPEN — Playbook ordering gap: the review prompt must be generated from the impl worktree BEFORE §3 collection removes it; §1.3 and §3 don't say so.
16. NOTE — `bunx tsc` resolves TypeScript 7.0.2 from bunx's cache; `typescript` is not a workspace dependency (pre-existing `tests/typecheck.ts` practice). Works, unpinned.
17. NOTE — `safety/no-pipe-swallowing` fires on `ls … | grep` (filter→filter), already tracked upstream (MIM-121 / claude-rules pack).
18. NIT — `WorkerRole` type now declared in both `shared-config.ts` (T1) and `workers/roles.ts`.
20. OPEN — A provider rate limit (HTTP 429, session limit) kills in-flight workers mid-task with no hand-back; their worktrees are retained with unverified edits. Resuming by agent id works (they continue from transcript), but the coordinator has to notice from the task notification — the playbook has no "worker died" path.
21. OPEN — Worker shells run zsh with `noclobber`: a `>` redirect onto an existing scratch log fails silently, the command never runs, and the worker read a STALE log ("222 packages installed") as a fresh result. Worker prompts/playbook should say `>|` or unique log names — or the worker shell should not inherit noclobber.
22. OPEN (same class as 9) — A follow-up worker spawned from an older integration tip gated against T0's red tests (its branch predated the T0 impl). Coordinator must merge the integration tip forward into a retained worker branch before re-gating; the playbook doesn't say so.
23. OPEN — After the coordinator collected and removed a worker's worktree, a late gate re-fire (SubagentStop path) drove the worker again: its cwd no longer existed, the gate ran against some other checkout, reported TS2307s from a dep-less tree and `ENOENT posix_spawn 'bunx'` (PATH in that hook context lacks bunx), and the worker sent a confused "my worktree is gone" report. The verify hook should no-op when `cwd` doesn't exist / the agent's worktree was collected, and collection should be able to mark an agent finished.
24. FIXED (on fix/verify-gate-branch-coverage, awaiting Rage's commit) — Rage's call: the test role skips `typecheck` as well as `test`; only `check` + sanity rules run for it, the impl gate typechecks everything. `verify.ts commandsFor` + docstring; existing test-role case updated (red→green). Was: Ledger #9 is a hard blocker now that typecheck actually runs: a test worker's red-first test that imports a NOT-YET-EXISTING export cannot typecheck, so the test-role gate blocks it (the typed-variable trick only works for existing functions; `@ts-expect-error` becomes an "unused directive" error for the impl worker, who can't touch tests). Decision needed before T2/T3.
25. OPEN — `maxTurns: 25` for mimir-test is tight once the worker must also `bun install` and touch two files: T3's test worker wrote both files (+156 lines) and ran out of turns before verifying/handing back. Resumed once per playbook. Either raise the test role's budget, or fix #7 so install stops eating turns.
26. OPEN — (T3's prompt: 1,003 lines. Workaround used: spawn the reviewer with the prompt FILE PATH and "read it and follow it exactly" — same bytes, no double relay; the playbook could adopt that as the standard delivery.) `review-prompt` inlines the full current content of every changed file (`maxLinesPerFile` 400): a change touching a README yields a 600-line prompt that is mostly unchanged prose, and the coordinator must relay it verbatim through its own context. Non-source files (md) could be limited to changed hunks with context, or a lower cap.
27. OPEN (root cause behind #22, hit again by T3 impl) — with `[verify] typecheck` running the WHOLE workspace, two tasks cannot be red at the same time: any package's committed red tests fail every other impl worker's gate until that package's impl lands. Parallel tasks are therefore serialised in practice. Fix options: per-package typecheck in `[verify]` (`tests/typecheck.ts <pkg>` already takes a filter — make it tolerate a non-package name by falling back to all, then `bun run --cwd "$(git rev-parse --show-toplevel)" typecheck "$(basename "$PWD")"`), or the playbook forbids parallel red states.
28. OPEN — A test worker adding green-on-arrival coverage cannot prove the test is sensitive: the mutation it would need (flip one word in source) is denied by its role, and nobody else in the loop does it either. Cheap primitive: a coordinator-side `mimir-cc mutate <file> <from> <to> -- <test cmd>` that applies, runs, reverts, and reports red/green — or the playbook accepts "reasoned, not observed" for coverage-only tasks.
29. OPEN — Playbook §3 says the post-merge gate is a no-op `mimir-impl` ("run the suite, change nothing"), but `verify.ts` blocks any `done` with an empty change set ("a done with nothing to verify is not accepted"). The two contradict; T4 was run by hand (same commands). Either the gate gets an explicit "integration check" mode, or the playbook drops the no-op worker for a coordinator-run command.
30. OPEN — Playbook §3's collection commit template (`<task>: <role>`) is not conventional-commit shaped; this repo versions releases from `feat:`/`fix:` subjects (scripts/release-package.sh), so a delegated feature would patch-bump. Template should be `test(<scope>): <task>` / `feat|fix(<scope>): <task>` / `refactor(<scope>): <task> review follow-up`, and the finishing section should recommend squash-merge with a conventional subject.
19. OPEN — `bun run typecheck` reported "Type errors in: plugin-core" with NO diagnostics when run concurrently with `bun run test` (T0 impl worker); re-run alone → 6/6 clean, no code change between. `tests/typecheck.ts` prints only the package name on a non-zero exit; and `bunx tsc` resolves from the bunx cache (possible concurrent-download race). The gate runs commands sequentially so it didn't hit this, but workers verifying by hand do.

## Log

- T1 test worker: 8 tests added (Test functions 5 → 13), red on missing `workerModelsFor` export. Gate passed; report said `Commands: (none)` — watch whether the impl gate actually runs the toolchain. Merged as 1bf63d9 / 42c569c.
- T1 impl worker: implementation complete and self-verified (13/13 in file; typecheck 0 errors; biome clean) but the verify gate blocked twice on coverage — `Source changed with no test added or modified: shared-config.ts`. STATUS: blocked. Worktree RETAINED at `.claude/worktrees/agent-a1e4f19f3caa94a6d` (branch `worktree-agent-a1e4f19f3caa94a6d`), holds the finished change; transcript `/private/tmp/claude-501/-Users-rageltd-Projects-mimir/e5792154-7da0-4484-9601-fea764c1fc52/tasks/a1e4f19f3caa94a6d.output`.
- **ESCALATION — structural gate flaw.** `verify/changes.ts resolveBase` = merge-base(worker HEAD, main-worktree HEAD) = the integration tip, where T1's red tests are already committed. `checks.ts coverageCheck` only looks at the worker's diff → every red-first impl diff is source-only → blocked. The playbook's red→green split and the per-worktree coverage check cannot coexist as built. Proposed fix (plugin-core `verify/`): coverage check also credits test files changed between merge-base(HEAD, trunk `main`) and the worker base (the integration branch's committed tests); sanity + test counts stay on the worker diff. Needs release or dev-install before the gate binary picks it up. Delegation stopped pending Rage's call.
- GATE FIX IN PROGRESS on branch `fix/verify-gate-branch-coverage` (off main; Rage commits): `verify/changes.ts` `ChangeSet.branchPaths` (paths committed between merge-base(base, main|master) and the worker base) + `checks.ts coverageCheck(files, branchPaths)` credits a test file among them; 6 new tests red→green; plugin-core 510 / cc 109 / oc 50 / typecheck / biome clean. Hygiene on the same branch: `biome.json` excludes `.claude/worktrees` (a retained worker worktree's own biome.json broke `bun run check` as a nested root) and `.gitignore` ignores `.claude/worktrees/`. SECOND FINDING: without a `[verify]` table the resolver fell to package.json scripts, which only carry `test` — the gate never typechecked or linted (test-role reports showed `Commands: (none)`). Added repo-level `mimir.toml` `[verify]` (test / `bunx tsc --noEmit -p tsconfig.json` / `bunx biome check .`, read-only). Dev binary installed via `scripts/dev-install.sh` (pin `~/.mimir/.cc-dev` set — remove after the next release). RESUME PLAN: Rage commits the fix branch → merge it into `mim-41-per-role-models` → merge that into the retained worker branch so its worktree carries mimir.toml → `delegate start` → SendMessage the impl worker to hand back again → gate: base = integration tip, diff = shared-config.ts only, branchPaths supplies the test, all three commands run.
- Gate fix committed as 77cf01e on `fix/verify-gate-branch-coverage`; merged into the integration branch (6c3c431) and forward into the retained worker branch (its uncommitted change intact, mimir.toml present). Coordinator re-activated; impl worker resumed to hand back through the fixed gate.
- T1 impl re-hand-back through the FIXED gate: coverage passed (branchPaths worked), typecheck passed, then `bun run test` failed on `brain/embedder.test.ts` "embeds a single query via the seam shape" (vector null) — unrelated to T1. That was the worker's THIRD block → loop guard exhausted → STATUS: failed. FLAKE CONFIRMED by re-running the package suite in the worktree: 1 fail / 5 runs observed overall, on DIFFERENT tests each time (`extract.test.ts` "strips markdown fences" 5s timeout on run 1; runs 2-3 green). Both are Bun.serve stub-server tests under `bun test --parallel` (14×). Pre-existing suite hermeticity problem, exposed by a fail-closed gate. T1's change itself is complete and verified in-worktree (518 pass when green). Awaiting decision on the lever (see chat).
- T0 test worker: 6 files (+133/−13): `healthTimeoutMs` red cases + generous opts on stub-backed cases in embedder.test.ts; `setDefaultTimeout(30_000)` in the six stub files. In-scope verification green (12 pass / 2 red by design; biome clean); its gate blocked only on the workspace typecheck failing on T1's committed red tests — a THIRD loop finding: red-first commits that add new API break every later worker's typecheck until the impl lands. Collected as f3f097a / 0f0eaa6 after reading the diff.
- T1 impl: gate re-driven by hand under the worker's own agent id with the machine idle → ✅ PASSED (base 6c3c431, diff shared-config.ts only, coverage from branchPaths, typecheck ✓ test ✓ check ✓). Impl diff read: matches the tests; nit — `WorkerRole` type now declared in both shared-config.ts and workers/roles.ts. Collected as 515960c / fe5149c. Review prompt generated before removal; mimir-review spawned. T0 impl worker spawned (worktree from 0f0eaa6).
- T1 review (cold): should-fix — `NO_WORKER_MODELS` shared singleton not frozen (`Object.freeze`); nits — doc comment should say unknown hosts/roles are discarded on read and that "absent, never {}" holds after readConfig (writeConfig will persist `{}`); no test for non-record shapes (`workerModels: []`, `claudeCode: "opus"`). Dispatched: T1-fix (mimir-impl, source) + T1-fix tests (mimir-test) in parallel with T0 impl.
- T0 review: should-fix (createEmbedQuery spread vs explicit undefined) + nits (export EmbedderOpts, bounded waitHealthy, comment) → follow-up impl passed gate, merged 73fa7df. Deferred nit: no guard on negative/NaN healthTimeoutMs (AbortSignal.timeout throws inside attempt → reads as "unhealthy").
- T1 follow-ups merged: 8bea105 (non-record coverage), 15f0dbb (freeze + docs). T1 DONE. T0 DONE.
- Gate change (test role skips typecheck) committed 3eb0ede on the fix branch, merged 25b5207. Dev binary rebuilt.
- Rage: workers now run on OPUS (Fable workers exhausted the usage cap) — coordinator passes `model: "opus"` on every spawn from here. T2 and T3 test workers spawned in parallel.
- T2 tests merged 51cb1b1 (3 → 9 test fns); T2 impl passed gate (typecheck ✓ test ✓ check ✓), merged 3a0935c; cold review spawned. T3 tests merged 2f64533 (10 → 20 test fns, after one turn-limit resume); T3 impl spawned.
- T3 impl passed gate after merge-forward (ledger #27), merged 61b77a7; cold review spawned (prompt delivered by file path — 1,003 lines). T2 review: should-fixes — formatWorkerModels belongs in plugin-core; no test pins the claudeCode namespace; README rationale for opus contradicts itself; nits — status prints the line too, prefix constant, hand-edit config survives update, rename `set`. OVERRULED finding: "Agent tool has no per-spawn `model`" — the tool schema in this session has `model: sonnet|opus|haiku|fable` and every worker since Rage's call has run on it. Dispatched T2-fix impl + T2-fix test in parallel.
- T2 review fix merged 2344fcb (formatWorkerModels → plugin-core shared-config with WORKER_MODELS_PREFIX; cc re-exports; README rationale rewritten; status line documented). T2-fix test (namespace wiring) in flight.
- T3 review: should-fixes — oc config.ts duplicated plugin-core's sanitizer (my spec said "keep the mirror"; reviewer right that the mirror's rationale is stale — oc config.ts becomes a re-export shim like cc's); install.ts wiring line untested. Nits — install rewrites config from the sanitised read (bad keys deleted, README should say); no provider/model validation (DECIDED: don't validate, ids churn; README says so); drop the key-position assertion in agents.test; explicit return annotation on oc readConfig (moot after the shim). Dispatched T3-fix impl + T3-fix test in parallel.
- Side findings from the impl worker: (1) worker worktrees start without `node_modules` — it ran `bun install --frozen-lockfile` before it could verify anything; (2) bare `bun test` inside plugin-core shows 2 pre-existing failures in `engine/provider/provider-data.test.ts` (cross-file module-store leak) that the package script's `--parallel src` does not — the gate should be using the script, verify when the gate first runs commands.
