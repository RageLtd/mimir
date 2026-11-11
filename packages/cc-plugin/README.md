# @mimir/cc-plugin

Claude Code plugin that runs vanilla Claude Code as Mimir: the plugin ships the lifecycle hooks and local MCP servers, the installer lands the persona and the binary behind them. Two ways in — the **Claude desktop app** (or a plain `claude`) in any project where the plugin is enabled, or the `mimir` **wrapper** in a terminal. Sidesteps Anthropic's SDK-usage caps by routing Mimir through the Claude Code subscription path instead of the Agent SDK.

## Architecture

Everything a session needs to be Mimir loads from two places: the plugin directory (hooks, MCP servers, workers, commands) and the files `/mimir-install` lands (persona, wrapper, binary, runtime config). The plugin must stay enabled wherever Mimir runs — Claude Code scopes plugin enablement per settings file, and that scoping is the per-project switch (see [Claude desktop app](#claude-desktop-app)).

```
<plugin root>/                 ← what Claude Code loads where the plugin is enabled
  hooks/register.ts            ← hooks module: persona (prompt.compose), boot context (prompt.context),
                                  retrieval + voice anchors (prompt.submit), tool gates (tool.call),
                                  session lifecycle (classic.*) — one file per concern
  hooks/hooks.json             ← names the module; no command hooks remain
  types/index.d.ts             ← the module's `$.state` contract (turn counter, agents)
  .mcp.json                    ← mimir-local + mimir-logs stdio servers (the installed binary)
  agents/                      ← delegation workers
  commands/                    ← slash commands

~/.local/bin/
  mimir                  ← wrapper script: binary update check, then exec claude --settings
  mimir-cc               ← compiled binary: install + hook handlers + MCP servers + enable/disable

~/.mimir/
  system-prompt.md       ← canonical Markdown fetched from mimir-server, unchanged and shared across hosts
  cc/system-prompt.xml   ← CC-only XML rendering with host context — what the hooks module composes
                            into every session's system prompt
  settings.json          ← wrapper-only settings (subagent env, deny list)
  config.json            ← runtime config consumed by the binary (server URL, DB path, cartographer path)
  user-memories.db       ← SQLite store backing the mimir-local MCP
  logs/mimir-cc.log      ← rolled append-only log from every hook + worker invocation
```

The persona is the hooks module's doing: its `prompt.compose` hook answers with the installed XML and nothing else, so the Mimir prompt replaces Claude Code's wholesale in every session where the plugin is enabled — desktop app, plain `claude`, wrapper alike. The wrapper adds nothing to the persona: it runs the binary update check, then `exec`s `claude --settings ~/.mimir/settings.json` so the user's global settings stay untouched — that flag is the only thing separating a wrapper session from a plain `claude` in an enabled project. Hooks and MCP servers come from the plugin in every launch path. `MIMIR_ACTIVE=1` is set on each binary invocation (in the module's `$.process.run` env, and exported by the wrapper) so the binary's gates pass.

## Claude desktop app

The desktop app's Code tab spawns `claude` with no flags, so a session can only become Mimir through what Claude Code loads on its own: the plugin, which carries the persona in its hooks module along with the lifecycle hooks and MCP servers. All of it loads wherever the plugin is enabled, and nothing else changes on the machine.

The same route covers **Zed's Claude Code agent**: its `claude-code-acp` adapter drives the real binary through the Agent SDK with user, project and local settings loaded, so an enabled project comes up as Mimir there too (verified live with adapter 0.85.0). The hooks' `↻` lines go through the engine's status line (`$.ui.status`), which each host renders its own way — the terminal TUI and the desktop app as a status line — rather than a command hook's `systemMessage`, which SDK-driven hosts used to glue onto the reply.

Enable it per project:

```bash
~/.local/bin/mimir-cc enable      # from inside the project; `disable` reverses it
```

This merges into the project's `.claude/settings.local.json` — per-user, gitignored, and copied into the worktrees the desktop app creates — the plugin enablement and the slice of the wrapper's settings a flag-less session would otherwise lack (subagent env, worktree base ref, secret-file deny list). `disable` removes exactly those entries and keeps anything you added or changed since; both drop the `"outputStyle": "Mimir"` an older `enable` wrote, now that the persona comes from the hooks module. `/mimir-install` offers to enable the project it runs in; after that, run the binary from any session's Bash, since the plugin's slash commands aren't loaded in a project where it is disabled.

For Mimir to stay out of other projects, the plugin must **not** be enabled in `~/.claude/settings.json` — `enable` prints a note when it is. One trade-off against the wrapper: **nested sessions** — a `claude` spawned from inside an enabled project also has the plugin enabled, so its hooks fire there too.

To run a session on a different model, pass `--model` to `mimir` or `claude` at launch, or use Claude Code's own `/model` inside the session.

## Install

There are two ways in. The **marketplace path** is the normal one — no clone, no local build; Claude Code pulls the plugin from GitHub and `/mimir-install` downloads a prebuilt binary. The **from-source path** is only for hacking on the plugin itself. Both converge on `/mimir-install`.

### Prerequisites

- **The GitHub CLI (`gh`), authenticated.** Release binaries live in the **private** `RageLtd/mimir` repo, and `/mimir-install` fetches them with your own `gh` credentials — so you need read access (repo collaborators qualify) and an active login:

  ```bash
  gh auth login
  ```

  No `gh`? `ensure-binary.sh` falls back to `curl` + `$GITHUB_TOKEN`, but `gh` is the path of least resistance.
- **`~/.local/bin` on your `PATH`.** That's where the `mimir` wrapper and the `mimir-cc` binary land. Without it, the `mimir` command won't resolve after install.

### Marketplace install (recommended)

1. Add RageLtd's plugin marketplace. The argument is `owner/repo` on GitHub — Claude Code reads `.claude-plugin/marketplace.json` from that repo and registers it under its declared name, **`rageltd`** (the same marketplace also carries goldfish, cartographer, and claude-rules):

   ```
   /plugin marketplace add RageLtd/claude-plugins
   ```

2. Install the plugin. The `@rageltd` suffix is the *marketplace* name, not the GitHub owner:

   ```
   /plugin install mimir-cc@rageltd
   ```

   The marketplace pins mimir-cc to a `git-subdir` source: it fetches `packages/cc-plugin` out of the `RageLtd/mimir` monorepo at the released tag (e.g. `cc-plugin/v0.1.0`), so you get the slash commands, scripts, and bundled artifacts without cloning the whole repo. The compiled `mimir-cc` binary is *not* in here — that arrives in the next step.

3. Run the installer inside Claude Code:

   ```
   /mimir-install
   ```

   It asks for the mimir-server URL (default `https://mimir.rageltd.ca`), the user-memory SQLite DB path (default `~/.mimir/user-memories.db`), and whether the server needs an API key (read from `MIMIR_API_KEY`, never pasted). Then `ensure-binary.sh` downloads the matching `mimir-cc-<platform>` asset from `RageLtd/mimir` releases, re-signs it on macOS to clear Bun's broken adhoc signature, and the installer writes out `~/.mimir/` and the wrapper — downloading the latest cartographer release (its `parse-only` build, see [Cartographer reindex](#cartographer-reindex)) and the embedder artifacts along the way. The embedder's `llama-server` comes in the GPU variant the machine can run — Metal on Apple Silicon; on Linux CUDA (chosen from the loaded NVIDIA driver's version, runtime libraries bundled), else ROCm when the HIP 7 runtime is installed, else Vulkan — and CPU-only otherwise; `mimir-cc update` swaps variants when a runtime appears.

4. Either let `/mimir-install` enable the project you're in and open a new desktop-app (or plain `claude`) session there, or run `mimir` from any terminal for the wrapper path.

To track a newer release later, run `/plugin marketplace update rageltd` to refresh the pinned tag, then `/mimir-update` to re-fetch the binary and re-land the runtime (without arguments it reuses the server URL stored in `~/.mimir/config.json`). After that first update you rarely need to: the installer turns on auto-update for the `rageltd` marketplace in the settings it writes, and at every session start the hooks module fetches the binary released under its own plugin version, so the plugin and its binary move together. The wrapper only fetches a binary when none is installed — unless you've pinned a dev build (see below), which nothing replaces. What changed between releases is on each `cc-plugin/v<version>` GitHub Release.

### From source (contributors)

Only needed if you're working on the plugin itself. It lives as the `@mimir/cc-plugin` package inside the `mimir` monorepo, and a marketplace clone can't build it (it lacks the monorepo's dependency catalogs), which is exactly why the marketplace path ships a prebuilt binary instead.

1. Clone the monorepo somewhere persistent.
2. Install workspace dependencies and build the installer binary:

   ```bash
   bun install                              # from the monorepo root — hoists workspace deps
   bun run --filter @mimir/cc-plugin build  # or: cd packages/cc-plugin && ./build.sh
   ```

   This produces `packages/cc-plugin/dist/darwin-arm64/mimir-cc` and `packages/cc-plugin/dist/linux-x64/mimir-cc`. On Darwin the script also runs `codesign --sign - --force` against the macOS binary — Bun's `bun build --compile` emits a broken adhoc signature that Gatekeeper kills on exec with no stderr (exit 137), so the re-sign is mandatory.
3. Add the monorepo as a local marketplace and install from it:

   ```
   /plugin marketplace add /path/to/mimir
   /plugin install mimir-cc@mimir-cc-local
   ```

   The monorepo root ships a `.claude-plugin/marketplace.json` naming the `mimir-cc-local` marketplace, pointed at `./packages/cc-plugin`.
4. Run `/mimir-install`. When developing, skip the release download and point the installer at your local `dist/<platform>/mimir-cc` build — the slash command spells out how. After the first install, `scripts/dev-install.sh` is the fast iterate loop: it rebuilds, atomically swaps `~/.local/bin/mimir-cc`, and drops `~/.mimir/.cc-dev` to pin the dev build so `ensure-binary.sh` won't clobber it mid-iteration. Delete that pin to resume tracking releases.

## Supported platforms

Releases ship `darwin-arm64` and `linux-x64` binaries only. Other platforms will error out of `/mimir-install`.

## Command surface

Slash commands inside Claude Code:

| Command | What it does |
|---------|--------------|
| `/mimir-install` | Land the runtime — binary, system prompt, cartographer, wrapper — and offer to enable the current project |
| `/mimir-update` | Re-fetch the binary and re-land the runtime. Without arguments it reuses the server URL from `~/.mimir/config.json` |
| `/mimir-disable` | Turn Mimir off for the current project (reverses `mimir-cc enable`) |
| `/run-hygiene` | Sweep the local replica. Dry-run by default; `--live` applies |
| `/add-grammar <language> [repo-url]` | Add a tree-sitter grammar to cartographer's host library (`~/.cartographer/grammars`), validate it, and re-index the current project |

Terminal subcommands on the `mimir-cc` binary — hooks aside, these are the
human-driven ones:

| Subcommand | What it does |
|------------|--------------|
| `mimir-cc enable [--project DIR] [--plugin KEY]` | Turn Mimir on for a project (desktop app path); `disable` reverses it |
| `mimir keys <status\|setup\|adopt\|rotate\|recovery-setup\|recover>` | E2E key ceremonies against an auth-enabled server |
| `mimir sync` | Pull + apply + push org memories, including the embedding backfill |
| `mimir-cc hygiene [--live] [--model <id>]` | The same local sweep `/run-hygiene` drives |
| `mimir-cc embed-backfill` | Vectorize replica memories that lack embeddings |

The ceremony and sync implementations are **shared plugin-core code** — the
identical commands work from `mimir-acp keys …`, `mimir-opencode keys …`, and
`mimir-codex keys …`. No editor owns a user-facing flow. Key hierarchy, the
device-secret store, the keychain-ACL note, and the `MIMIR_KEY_PASSPHRASE`
fallback are documented once in
[`packages/plugin-core/README.md`](../plugin-core/README.md#keys-and-sync).

`mimir keys setup` prints your **device secret exactly once** — store it in
your password manager; it is the only way to bring a new device online.

## Resuming and Remote Control

Persona, hooks and MCP servers all come from the plugin, so any session in
an enabled project is Mimir however it was started. In practice:

- **Resume however you like.** `mimir --continue` and `mimir --resume <id>`
  pass straight through to `claude` with every flag intact; a bare
  `claude --resume`, or resuming from the Claude desktop app, reopens the
  transcript with the same plugin and the same persona.
- **Remote Control, interactive mode, works as-is.** `mimir --rc` (or `/rc`
  inside a running session) attaches Remote Control to the already-running
  process, so claude.ai/code and the mobile app drive the same Mimir session,
  flags and all. Keep the process alive — tmux over ssh, say — and accept the
  workspace-trust dialog in that directory once beforehand.
- **Remote Control server mode** (`claude remote-control`) spawns fresh
  sessions without wrapper flags; in an enabled project they behave like
  desktop-app sessions.

## What the install lands

### Hooks module (plugin `hooks/register.ts`)

The in-process half of the plugin, loaded through `hooks.json`'s `modules` entry (Claude Code ≥ 2.1.319). One file per concern; each reaches the brain by running the installed binary through `$.process.run` (with `MIMIR_ACTIVE=1` set for the run, so the binary's gates pass) and fails open with a status line, so a binary that errors costs that leg and never the prompt or the tool call. `claude plugin validate .` reads it the way the engine will; `claude plugin test .` runs the kit tests beside it.

- **`prompt.compose` → persona.** Answers with the installed `~/.mimir/cc/system-prompt.xml` in place of the engine's own sections, in every session. Three of the engine's sections are kept ahead of it, because the persona has no answer for them: `user_privacy` (keep the developer's details out of requests to outside services), `session_guidance` (how a typed `/<skill>` is invoked) and `context_management` (a long conversation is summarised). The engine's leading "You are Claude Code" line is outside what a module answers and stays; the persona's environment block says what it means. Falls back to the canonical Markdown, and to Claude Code's own prompt (with a status line saying so) when no persona is installed.
- **`prompt.context` → `mimir-cc boot-context`.** Appends the `<boot_context>` block — user profile and active project from the local stores — to the blocks the conversation's first user message carries. The engine re-renders those after a compaction or `/clear`, so the profile survives both. No prior-session section here: this fires before any prompt exists to query with.
- **`prompt.submit` → `mimir-cc retrieve` and `mimir-cc voice-anchor`.** Counts the developer's turns in `$.state`. Every turn, retrieval: the relevant project memories, summaries and playbooks for the prompt, attached as prompt context, with the "↻ Retrieved N memories" line on the status bar. Every `MIMIR_ANCHOR_INTERVAL` turns (default 3), and on the first prompt after a compaction, a voice anchor: `voice-anchor --session <id> --nth <n>` returns the next exchange in the session's rotation of the prompt's `<voice_in_action>` library, attached after the retrieval. Recency-slot persona refresh that counteracts long-context drift; the rotation starts at a hash of the session id so short sessions don't all open on the same exchange, and the binary keeps no state.
- **`tool.call` → `mimir-cc rules` and `mimir-cc guard`.** The one unmatched tool hook, run on every call with the PreToolUse-shaped payload the two subcommands read. *Rules* runs the engine against every `.claude/**/*.enforce.toml` file under the project root: a blocking finding denies the call with the findings as the reason; a nudge rides the tool's result as context the model reads after it. See [Rules engine](#rules-engine). *Guard* is the role guard for autonomous workers. `tool.call` fires inside subagents too, carrying the loop's `agentId`; the module records each worker's cwd (its worktree) and type at `classic.SubagentStart` and fills them in, so `mimir-impl`/`mimir-test`/`mimir-review` map to their roles, no agent is the main session (`coordinator`), and any other subagent is left alone. The coordinator role stays silent unless the delegation skill has written an active coordinator state for the session (`~/.mimir/agents/<session>.json`). Denies: `impl` writing test files, `test` writing anything else, `review` writing at all, the coordinator writing files, spawning a worker before its plan file exists, or reading implementation inside a worker worktree. Every role: `git push`, `git reset --hard`, `git branch -D`, `git clean -f`, `rm -r` outside the agent's worktree, and any read or write of secret material (`.env*`, keys, `~/.ssh`, `~/.aws`…). The same secret paths are also `Read(...)` deny rules in the installed settings, so Bash `cat` is covered too. The decision is `guardDecision` in plugin-core; the subcommand only builds the context and speaks the hook protocol. Both legs run at once and fail open on their own.
- **`tool.call` (Bash) → edit guard, in-process.** Claude Code's auto permission mode tells the model to prefer Bash (sed, heredocs, scripts) over Edit/Write, which hides changes from the chat. This hook denies a Bash command that rewrites a single explicit file — `sed -i` on one path, a redirect or heredoc into one path, `tee` to one path, an inline `python`/`node`/`perl` snippet writing one literal path — with a reason pointing the model at the Edit tool. Bulk mechanical edits (several paths, globs, `find`/`xargs`, `git ls-files`, loops, `glob`/`os.walk` in a script) are denied too — a shell edit bypasses every file rule in the engine and never shows as a diff; the reason points at the Edit tool per file, or the project's formatter/codemod for a genuine sweep. Read-only uses, scratch paths under `/tmp`, and anything ambiguous pass silently; a hook that blocks a legitimate command is the worse failure. The classifier (`hooks/shell-edit.ts`) runs in the module itself — no binary — and the deny holds in every permission mode. Set `MIMIR_EDIT_GUARD=0` to disable it for a session.
- **`tool.call` (Read) → `mimir-cc file-context`.** Runs beside the read, never ahead of it, and attaches the file's cartographer info (symbols, imports, dependents) and related memories from the local index and replica to the result as context, with the "↻ File context" line on the status bar. The binary dedupes per session by content hash.
- **`tool.call` (Edit, Write) → `mimir-cc reindex`.** Once the write has landed: the binary forks a detached cartographer worker that parses the changed file into the local index and exits at once. A subagent's edit (inside its worktree) is skipped.
- **`tool.call` (SubagentHandback) and `classic.SubagentStop` → `mimir-cc verify`.** The gate on a worker's "done" claim: re-checks the worker's worktree before the hand-back is accepted. On the hand-back, a block denies the call (the worker keeps working) and a pass rewrites the message with the report appended; on SubagentStop — the fallback for hosts without the hand-back tool — a block stops the worker and a pass hands the report on as context.
- **`classic.SessionStart` → `mimir-cc session-start`.** On startup or resume (the classic event carries `source`; the engine's `session.start` does not): silent key reconcile and blind org sync (bounded), then a detached full re-index of the project into the local cartographer index.
- **`turn.complete` (main loop) → `mimir-cc persist`.** The messages since the last distillation, read from `$.session.messages({ as: "api" })` with media stripped, distilled into the local replica. Where the last distillation stopped is an anchor in `$.state` (`hooks/messages.ts`) that the module moves when the binary answers `{ advance: true }`; it finds its place again after the engine's 4096-row window slides. A subagent's turns are its own.
- **`session.compact` (main loop) → `mimir-cc precompact`.** The undistilled tail, summarised and extracted before Claude Code compacts the context; afterwards the anchor is the compacted conversation, so the engine's summary is never distilled as a turn. A `precompute` passes over — it installs nothing.

Both distillation legs run on the session's own model client, so a Claude Code session needs no extraction endpoint. The module marks its payload `host_completions: true`; with no `extractionBaseUrl` configured the binary answers its first run with `requests` — the extraction (and, for precompact, summary) prompts it rendered — which the module runs in parallel through `$.model.complete` on `haiku` at low effort, then hands back as `completions` on a second run that parses and stores them. A configured `extractionBaseUrl` and `extractionModel` still win: the binary extracts through that endpoint in one run, as OpenCode, Codex and ACP always do.

Neither leg holds the user. The hook captures the delta, marks it `pending` in `$.state`, and schedules the run with `$.clock.after(0, …)`, so `turn.complete` and `session.compact` pass on at once and distillation runs after them. One persist is in flight at a time: a turn that ends while one is pending schedules nothing, and the next turn's delta carries its messages. A pending older than a worst-case persist plus a minute's slack (`PENDING_STALE_MS`, 260 s — a session that ended mid-run) blocks nothing. A pathological precompact can outlive that and overlap a persist; its duplicate facts dedupe and both anchor writes are version-checked. A precompact always schedules, and its anchor write lands only if no re-anchor came first.

`hooks.json` names the module and nothing else: there are no command hooks left. `manifests.spec.ts` pins every subcommand the module runs to the CLI's dispatch table.

### Settings (`~/.mimir/settings.json`, wrapper only)

The wrapper passes this file with `--settings`. Besides the subagent env and the secret-file deny list it carries one key: **`worktree.baseRef: "head"`**, so worker worktrees branch from the current `HEAD` rather than the remote default branch and a worker sees the coordinator's integration branch instead of `main`.

### Runtime config (config.json)

`~/.mimir/config.json` is the shared runtime config every distribution reads (see [`packages/plugin-core/README.md`](../plugin-core/README.md#shared-config)). One key is delegation-specific:

```json
{
  "workerModels": {
    "claudeCode": { "impl": "opus", "test": "opus", "review": "opus" },
    "opencode": { "impl": "anthropic/claude-opus-4-5" }
  }
}
```

Each host namespace pins a model per worker role. `claudeCode` values are Agent-tool tiers — `sonnet`, `opus`, `haiku`, `fable`; `opencode` values are `provider/model` ids. A missing key, namespace or role means that role runs on the coordinator's own model. `delegate start` reports what it resolved on a `worker models:` line — `delegate status` prints the same line — and the `/delegate` playbook passes each named model on that role's spawns.

Left unset, every worker inherits the coordinator's model. That matters when the coordinator runs a premium tier: three workers on Fable exhaust a subscription's budget fast, on work the coordinator never reads in full. Pin the `claudeCode` roles to `opus` in that case. If the coordinator is already on `opus` or something cheaper, pinning changes nothing or costs more — leave it unset. The installed `settings.json` also sets `CLAUDE_CODE_SUBAGENT_MODEL=opus`, so any other subagent (Explore, the docs guide) defaults to `opus` rather than the coordinator's model; a per-spawn `model` still wins.

The same table can live in `mimir.toml` — developer intent rather than installer state, layered user (`~/.mimir/mimir.toml`) then project (`./mimir.toml`), and it wins over `config.json` role by role:

```toml
[workers.models.claudeCode]
review = "sonnet"          # only the review role changes; impl/test stay on config.json

[workers.models.opencode]
impl = "ollama/qwen3"      # an OpenCode project on local models
```

A project's `mimir.toml` is committable, so a repo can pin its own worker models for everyone who delegates in it.

Nothing prompts for `workerModels`: set it by hand-editing `~/.mimir/config.json`. The edit survives `/mimir-update`, which merges the installer's keys over the existing config rather than replacing it.

### Workers (plugin `agents/`)

The three delegation workers — `mimir-impl`, `mimir-test`, `mimir-review` — ship as subagent files in this plugin's `agents/` directory, not in `~/.mimir`. The plugin directory is what Claude Code re-reads on `/reload-plugins`, on an agent-view respawn and on a desktop resume, so the workers survive all three; definitions passed on argv survive none of them. Each file is rendered from `packages/server/system-prompt.md` by `bun run --cwd packages/cc-plugin agents:render` (the "how to do work" sections plus a role contract, no persona) and committed; `agents.spec.ts` fails when the committed files drift from the renderer, so re-render after editing the seed or `plugin-core/src/workers`. The worker prompt therefore tracks the plugin release, not the served prompt.

Plugin agents cannot carry frontmatter hooks, so the role guard is the plugin's `guard` hook above — which, now that the hooks ship in the plugin, also fires in a plain `claude` or desktop-app session with the plugin enabled, so the workers are guarded there too.

### MCP servers (plugin `.mcp.json`)

Both servers ship in the plugin and run the installed binary (`${HOME}/.local/bin/mimir-cc`, expanded by Claude Code). Because the plugin provides them, Claude Code prefixes their tools with the plugin and server names.

- **`mimir-local`**. The `mimir-cc user-memory-mcp` subcommand. Exposes the local memory brain: developer-scoped memory + profile tools (`user_memory_*`, `user_profile_*`), project memory + playbook tools (`project_memory_*`, `project_playbook_*`) over the local org replica, and the Cartographer tools over the local index. Tools arrive prefixed as `mcp__plugin_mimir-cc_mimir-local__*`. The user-memory DB path resolves from `MIMIR_USER_MEMORY_DB`, then `userMemoryDb` in `~/.mimir/config.json`, then `~/.mimir/user-memories.db`.
- **`mimir-logs`**. The `mimir-cc log-mcp` subcommand — reads the local plugin logs for self-debugging. Tools arrive prefixed as `mcp__plugin_mimir-cc_mimir-logs__*`.

The standalone `cartographer --parse-only` MCP server the wrapper used to pass is gone. Nothing in Mimir referenced it, and without a database that mode could only parse files, not answer structure queries. The cartographer binary is still used — as a parser subprocess the reindex and session-start hooks spawn to populate the local index that `mimir-local` serves from.

## Rules engine

Rules live in `.claude/**/*.enforce.toml` files relative to the project root. One rule per file. Format:

```toml
id = "no-console-log"
event = "file"  # one of: bash | file | stop | prompt | all
message = "Don't ship console.log statements: ${match}"

[[conditions]]
field = "new_text"            # see resolveField in src/rules/matcher.ts
operator = "regex_match"      # regex_match | contains | equals
pattern = "console\\.log\\("
```

Use `detector = "builtin:<name>"` (with optional `detector_args = { ... }`) instead of `[[conditions]]` for rules that need real logic — currently `builtin:file-length` for post-edit line-count caps. See `src/rules/builtins.ts` for the registry.

`message` supports `${match}`, `${1}`-`${9}` capture groups, and `${line}` interpolation. `negative_conditions` (same shape as `conditions`) suppress the rule when any negative matches. `exclude_globs = ["**/*.test.ts"]` skips matching paths. `body = "path/to/longer-rule.md"` inlines a full rationale block into the model-facing nudge.

## Voice anchor

`mimir-cc voice-anchor --session <id> --nth <n>` prints the n-th exchange of a session's rotation through the system prompt's `<voice_in_action>` library as a `<voice_anchor>` block. The hooks module's `prompt.submit` hook runs it every `MIMIR_ANCHOR_INTERVAL` turns (default 3), counting turns in `$.state`, and attaches the block to the prompt. The rotation starts at a hash of the session id so every fresh session doesn't anchor on turn 3 with the same exchange; the binary itself keeps no state.

## Cartographer reindex

The installer always lands a cartographer binary: the `cartographer-parse-only-<platform>` asset of the latest `RageLtd/cartographer` GitHub release — the build without cartographer's SurrealDB feature, since Mimir owns the index and uses the binary purely as a parser — downloaded into `~/.mimir/bin` and refreshed on `update` when a newer release exists. Nothing already on the machine is picked up — a binary Mimir didn't fetch is one it can't keep current; `--cartographer PATH` is the only override (a local build, say). With it in place the `PostToolUse` reindex hook fires on every Edit/Write/MultiEdit. The hook itself is a fast detached fork — spawns `mimir-cc reindex --worker <project> <file>` and exits 0 immediately so the next CC turn isn't blocked on a Rust binary.

The worker spawns cartographer in `--parse-only` mode, parses the changed file, hashes the contents (SHA-256), and writes the result to the local cartographer index — nothing leaves the machine (MIM-91). Failures get logged but never block the user's tool call.

Cartographer parses six languages out of the box and loads any other tree-sitter grammar from `~/.cartographer/grammars/<name>/` at startup. `/add-grammar <language>` walks through installing one — build with the tree-sitter CLI, `tags.scm` / `imports.scm` queries, `language.json` manifest, validation with `cartographer grammars` and `cartographer parse` — and finishes with `mimir-cc session-start --worker <project>`, the same full replace-mode re-index the SessionStart hook runs. Because every re-index spawns a fresh cartographer, that *is* the restart; no new session is needed.

## Building

```bash
bun install                              # from the monorepo root — hoists workspace deps
bun run --filter @mimir/cc-plugin build  # or: cd packages/cc-plugin && ./build.sh
```

`dist/` is gitignored. For local development the slash command resolves the binary at `${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc`, so a fresh clone needs `./build.sh` once before `/mimir-install` will work. The build step ad-hoc-signs the Darwin binary; without that, the binary dies with SIGKILL on every invocation. For released installs the binary instead comes from `RageLtd/mimir` GitHub Releases: the `cc-plugin Release` workflow (`.github/workflows/cc-plugin-release.yml`) auto-versions from conventional commits (via the shared `scripts/release-package.sh` at the repo root), cross-compiles both platforms, publishes the assets on a `cc-plugin/v<version>` tag, and dispatches an event to the `RageLtd/claude-plugins` marketplace to bump its pinned ref. `scripts/ensure-binary.sh` is what pulls those assets onto the user's machine — a drift-tested byte-identical mirror of the canonical copy at `packages/plugin-core/scripts/ensure-binary.sh` (the marketplace git-subdir clone contains only this package, so the script must live here physically; edit the plugin-core copy and re-copy).

## Layout

```
packages/cc-plugin/                          ← workspace member @mimir/cc-plugin
  .claude-plugin/plugin.json                 ← plugin manifest (marketplace.json lives at monorepo root)
  .mcp.json                                  ← plugin-shipped MCP servers (mimir-local, mimir-logs)
  hooks/hooks.json                           ← names the module (`modules`), nothing else
  hooks/{register,persona,lifecycle,boot,submit,gate,edit-guard,file-context,reindex}.ts
                                             ← the hooks module, one file per concern; binary.ts and
                                                payload.ts shape the $.process.run calls, shell-edit.ts
                                                is the edit guard's classifier; *.test.ts are kit tests
  types/index.d.ts                           ← the module's $.state contract (turn counter, agents)
  commands/{mimir-install,mimir-update,mimir-disable,delegate,...}.md   ← slash commands
  agents/                                    ← delegation workers (rendered from the prompt seed)
  src/                                       ← thin Claude Code wiring; the brain, stores, rules engine,
                                                cartographer client and MCP servers live in plugin-core
    cli.ts                                   ← subcommand dispatcher
    cli-args.ts                              ← install/update argument parsing
    install.ts                               ← fetch + convert + write (persona, wrapper)
    project-settings.ts                      ← `enable` / `disable`: the per-project switch
    config.ts, logger.ts                     ← shims binding plugin-core's shared modules to this host
    boot-context.ts, voice-anchor.ts, retrieve-hook.ts, file-context-hook.ts,
    rules-hook.ts, guard-hook.ts, verify-hook.ts, reindex-hook.ts,
    session-start-hook.ts, persist-hook.ts, precompact-hook.ts
                                             ← the subcommands the hooks module runs
    edit-guard.spec.ts                       ← Bun corpus test for hooks/shell-edit.ts
    user-memory-mcp.ts, log-mcp.ts           ← entry points for the two plugin MCP servers
    delegate-command.ts, hygiene-command.ts, backfill-command.ts   ← human-driven subcommands
    agents.ts, worktree-bootstrap.ts, conversation.ts
  artifacts/                                 ← templates bundled into the binary
    settings.json.template
    wrapper.sh.template
  dist/                                      ← gitignored, populated by ./build.sh
    darwin-arm64/mimir-cc
    linux-x64/mimir-cc
  build.sh
```
