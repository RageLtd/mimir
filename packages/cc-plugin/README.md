# @mimir/cc-plugin

Claude Code plugin that runs vanilla Claude Code as Mimir: the plugin ships the lifecycle hooks and local MCP servers, the installer lands the persona and the binary behind them. Two ways in — the **Claude desktop app** (or a plain `claude`) in any project where the plugin is enabled, or the `mimir` **wrapper** in a terminal. Sidesteps Anthropic's SDK-usage caps by routing Mimir through the Claude Code subscription path instead of the Agent SDK.

## Architecture

Everything a session needs to be Mimir loads from two places: the plugin directory (hooks, MCP servers, workers, commands) and the files `/mimir-install` lands (persona, wrapper, binary, runtime config). The plugin must stay enabled wherever Mimir runs — Claude Code scopes plugin enablement per settings file, and that scoping is the per-project switch (see [Claude desktop app](#claude-desktop-app)).

```
<plugin root>/                 ← what Claude Code loads where the plugin is enabled
  hooks/hooks.json             ← lifecycle hooks, each `MIMIR_ACTIVE=1 "$HOME/.local/bin/mimir-cc" <sub>`
  .mcp.json                    ← mimir-local + mimir-logs stdio servers (the installed binary)
  agents/                      ← delegation workers
  commands/                    ← slash commands

~/.local/bin/
  mimir                  ← wrapper script: claude --system-prompt-file + --settings, model-switch loop
  mimir-cc               ← compiled binary: install + hook handlers + MCP servers + enable/disable

~/.claude/output-styles/
  mimir.md               ← the persona as the "Mimir" output style — what a desktop-app session selects

~/.mimir/
  system-prompt.md       ← fetched from mimir-server, XML-converted at install (wrapper sessions)
  settings.json          ← wrapper-only settings (subagent env, deny list, outputStyle off)
  config.json            ← runtime config consumed by the binary (server URL, DB path, cartographer path)
  user-memories.db       ← SQLite store backing the mimir-local MCP
  voice-state/           ← per-session anchor counters
  logs/mimir-cc.log      ← rolled append-only log from every hook + worker invocation
```

The wrapper invokes `claude --system-prompt-file ... --settings ...` so the Mimir persona replaces CC's default system prompt while the user's existing global CC settings stay untouched; hooks and MCP servers come from the plugin in every launch path. `MIMIR_ACTIVE=1` is set inline on each plugin hook (and exported by the wrapper) so the binary's gates pass.

## Claude desktop app

The desktop app's Code tab spawns `claude` with no flags, so a session can only become Mimir through what Claude Code loads on its own. The plugin carries the hooks and MCP servers; the persona arrives as the **Mimir output style** the installer writes to `~/.claude/output-styles/mimir.md`. Both load wherever the plugin is enabled, and nothing else changes on the machine.

The same route covers **Zed's Claude Code agent**: its `claude-code-acp` adapter drives the real binary through the Agent SDK with user, project and local settings loaded, so an enabled project comes up as Mimir there too (verified live with adapter 0.85.0). The hooks' `↻` status lines are suppressed for SDK-driven hosts, which render a `systemMessage` as a notice glued onto the reply; the terminal TUI and the desktop app render it as a proper status line and keep it.

Enable it per project:

```bash
~/.local/bin/mimir-cc enable      # from inside the project; `disable` reverses it
```

This merges into the project's `.claude/settings.local.json` — per-user, gitignored, and copied into the worktrees the desktop app creates — the plugin enablement, `"outputStyle": "Mimir"`, and the slice of the wrapper's settings a flag-less session would otherwise lack (subagent env, worktree base ref, secret-file deny list). `disable` removes exactly those entries and keeps anything you added or changed since. `/mimir-install` offers to enable the project it runs in; after that, run the binary from any session's Bash, since the plugin's slash commands aren't loaded in a project where it is disabled.

For Mimir to stay out of other projects, the plugin must **not** be enabled in `~/.claude/settings.json` — `enable` prints a note when it is. The trade-offs against the wrapper:

- **Persona strength.** An output style replaces Claude Code's software-engineering instructions with Mimir's but keeps the rest of the default prompt (tool policy, safety, a tone section) — roughly the size of Mimir's own prompt again. Claude Code frames the style as the authority on how to respond, and the `<model_override>` block says the persona wins where the two differ, but it is not the wholesale replacement the wrapper gets. Persona fidelity in the app is the thing to measure.
- **No `/switch-model`.** Only the wrapper can relaunch under another model; the command says so when run from the app.
- **Nested sessions.** A `claude` spawned from inside an enabled project also has the plugin enabled, so its hooks fire there too.

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

   It asks for the mimir-server URL (default `https://mimir.rageltd.ca`), the user-memory SQLite DB path (default `~/.mimir/user-memories.db`), and whether the server needs an API key (read from `MIMIR_API_KEY`, never pasted). Then `ensure-binary.sh` downloads the matching `mimir-cc-<platform>` asset from `RageLtd/mimir` releases, re-signs it on macOS to clear Bun's broken adhoc signature, and the installer writes out `~/.mimir/`, the Mimir output style, and the wrapper — downloading the latest cartographer release and the embedder artifacts along the way.

4. Either let `/mimir-install` enable the project you're in and open a new desktop-app (or plain `claude`) session there, or run `mimir` from any terminal for the wrapper path.

To track a newer release later, run `/plugin marketplace update rageltd` to refresh the pinned tag, then `/mimir-update` to re-fetch the binary and re-land the runtime (without arguments it reuses the server URL stored in `~/.mimir/config.json`). `ensure-binary.sh` also runs on every `mimir` launch, so simply starting the wrapper usually pulls the latest release on its own — unless you've pinned a dev build (see below).

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
| `/mimir-install` | Land the runtime — binary, system prompt, output style, cartographer, wrapper — and offer to enable the current project |
| `/mimir-update` | Re-fetch the binary and re-land the runtime. Without arguments it reuses the server URL from `~/.mimir/config.json` |
| `/mimir-disable` | Turn Mimir off for the current project (reverses `mimir-cc enable`) |
| `/switch-model` | Stage `~/.mimir/next-session.json` so the wrapper relaunches on a different model. Wrapper sessions only. The next session starts fresh — continuity bridges through a project-memory checkpoint, because extended-thinking signatures don't survive cross-backend transcript replay |
| `/run-hygiene` | Sweep the local replica. Dry-run by default; `--live` applies |

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

Hooks and MCP servers come from the plugin, so any session in an enabled
project has them however it was started. Only the full persona prompt is
wrapper-specific; elsewhere the persona is the Mimir output style. In practice:

- **Resume through the wrapper** to keep the full prompt. `mimir --continue`
  and `mimir --resume <id>` pass straight through to `claude` with every flag
  intact. A bare `claude --resume`, or resuming from the Claude desktop app,
  reopens the transcript with the plugin's hooks and MCP servers and, in an
  enabled project, the output-style persona.
- **Remote Control, interactive mode, works as-is.** `mimir --rc` (or `/rc`
  inside a running session) attaches Remote Control to the already-running
  process, so claude.ai/code and the mobile app drive the same Mimir session,
  flags and all. Keep the process alive — tmux over ssh, say — and accept the
  workspace-trust dialog in that directory once beforehand.
- **Remote Control server mode** (`claude remote-control`) spawns fresh
  sessions without wrapper flags; in an enabled project they behave like
  desktop-app sessions.

## What the install lands

### Hooks (plugin `hooks/hooks.json`)

These hooks ship in the plugin and fire wherever it is enabled. Each command is `MIMIR_ACTIVE=1 "$HOME/.local/bin/mimir-cc" <subcommand>` — the installed binary, with the gate every handler checks set inline. `manifests.test.ts` pins each subcommand to the CLI's dispatch table.

- **`SessionStart` → session-start.** On startup or resume: silent key reconcile and blind org sync (bounded), then a detached full re-index of the project into the local cartographer index.
- **`UserPromptSubmit` → voice-anchor.** Assembles the boot-context block (user profile, recent project memories, session context) on every prompt, and every N turns (default 5, override via `MIMIR_ANCHOR_INTERVAL`) injects a `<voice_anchor>` block sampled from the system prompt's voice library. Recency-slot persona refresh that counteracts long-context drift.
- **`UserPromptSubmit` → retrieve.** Per-turn brain retrieval: the relevant project memories, summaries and playbooks for the prompt, injected as `additionalContext`.
- **`PreToolUse` (Read) → file-context.** Enriches a file read with its cartographer info (symbols, imports, dependents) and related memories from the local index and replica.
- **`PreToolUse` → rules.** Runs the rule engine against every `.claude/**/*.enforce.toml` file under the project root. On match, emits `additionalContext` with the violation message so the model sees the nudge alongside the tool call. See [Rules engine](#rules-engine).
- **`PreToolUse` (Bash) → edit-guard.** Claude Code's auto permission mode tells the model to prefer Bash (sed, heredocs, scripts) over Edit/Write, which hides changes from the chat. This hook denies a Bash command that rewrites a single explicit file — `sed -i` on one path, a redirect or heredoc into one path, `tee` to one path, an inline `python`/`node`/`perl` snippet writing one literal path — with a reason pointing the model at the Edit tool. Bulk mechanical edits (several paths, globs, `find`/`xargs`, `git ls-files`, loops, `glob`/`os.walk` in a script) are denied too — a shell edit bypasses every file rule in the engine and never shows as a diff; the reason points at the Edit tool per file, or the project's formatter/codemod for a genuine sweep. Read-only uses, scratch paths under `/tmp`, and anything ambiguous pass silently; a hook that blocks a legitimate command is the worse failure. Hooks run before the permission check in every mode, so the deny holds under auto. Set `MIMIR_EDIT_GUARD=0` to disable it for a session.
- **`PreToolUse` → `guard`.** The role guard for autonomous workers. One hook covers every role: a plugin-level `PreToolUse` fires inside subagents too, and there the payload's `agent_type` names the worker, so `mimir-impl`/`mimir-test`/`mimir-review` map to their roles, no `agent_type` is the main session (`coordinator`), and any other subagent is left alone. The coordinator role stays silent unless the delegation skill has written an active coordinator state for the session (`~/.mimir/agents/<session>.json`). Denies: `impl` writing test files, `test` writing anything else, `review` writing at all, the coordinator writing files, spawning a worker before its plan file exists, or reading implementation inside a worker worktree. Every role: `git push`, `git reset --hard`, `git branch -D`, `git clean -f`, `rm -r` outside the agent's worktree, and any read or write of secret material (`.env*`, keys, `~/.ssh`, `~/.aws`…). The same secret paths are also `Read(...)` deny rules in the installed settings, so Bash `cat` is covered too. The decision is `guardDecision` in plugin-core; this hook only builds the context and speaks the hook protocol.
- **`PreToolUse` (SubagentHandback) and `SubagentStop` → verify.** The gate on a worker's "done" claim: re-checks the worker's worktree before the hand-back is accepted.
- **`PostToolUse` (Edit | Write | MultiEdit) → reindex.** Spawns a detached cartographer worker that parses the changed file and updates the local cartographer index.
- **`Stop` → persist.** Ships the transcript delta to the local brain for memory extraction and summarisation.
- **`PreCompact` (auto, manual) → precompact.** Persists what is about to be discarded before Claude Code compacts the context.

### Settings (`~/.mimir/settings.json`, wrapper only)

The wrapper passes this file with `--settings`. Besides the subagent env and the secret-file deny list it carries three keys:

- **`outputStyle: "default"`.** An output style is still appended when `--system-prompt-file` replaces the prompt (verified empirically), so a wrapper session in an enabled project would otherwise carry the persona twice. Command-line settings outrank project settings, so this switches the Mimir style off under the wrapper only.

- **`disableAgentView: true`.** Claude Code's agent view (`←` on an empty prompt) re-spawns the session as a fresh `claude` process carrying only `--settings`, `--mcp-config` and `--permission-mode` — the persona (`--system-prompt-file`) is dropped. Off, the wrapper's flags stay in force for the life of the session.
- **`worktree.baseRef: "head"`.** Worker worktrees branch from the current `HEAD` rather than the remote default branch, so a worker sees the coordinator's integration branch instead of `main`.

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

The three delegation workers — `mimir-impl`, `mimir-test`, `mimir-review` — ship as subagent files in this plugin's `agents/` directory, not in `~/.mimir`. The plugin directory is what Claude Code re-reads on `/reload-plugins`, on an agent-view respawn and on a desktop resume, so the workers survive all three; definitions passed on argv survive none of them. Each file is rendered from `packages/server/system-prompt.md` by `bun run --cwd packages/cc-plugin agents:render` (the "how to do work" sections plus a role contract, no persona) and committed; `agents.test.ts` fails when the committed files drift from the renderer, so re-render after editing the seed or `plugin-core/src/workers`. The worker prompt therefore tracks the plugin release, not the served prompt.

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

The `voice-anchor` subcommand runs as the `UserPromptSubmit` hook. Every prompt assembles the boot-context block — user profile and freeform memories from `~/.mimir/user-memories.db`, recent project memories from the local org replica. Every `MIMIR_ANCHOR_INTERVAL` turns (default 5) it also samples one exchange from the system prompt's `<voice_in_action>` library and prepends a `<voice_anchor>` block to the user prompt.

State lives per-session at `~/.mimir/voice-state/<session-id>.json`. The hash-of-session-start offset prevents every fresh session from anchoring on turn 5 with the same exchange.

## Cartographer reindex

The installer always lands a cartographer binary: the latest `RageLtd/cartographer` GitHub release, downloaded into `~/.mimir/bin` and refreshed on `update` when a newer release exists. Nothing already on the machine is picked up — a binary Mimir didn't fetch is one it can't keep current; `--cartographer PATH` is the only override (a local build, say). With it in place the `PostToolUse` reindex hook fires on every Edit/Write/MultiEdit. The hook itself is a fast detached fork — spawns `mimir-cc reindex --worker <project> <file>` and exits 0 immediately so the next CC turn isn't blocked on a Rust binary.

The worker spawns cartographer in `--parse-only` mode, parses the changed file, hashes the contents (SHA-256), and writes the result to the local cartographer index — nothing leaves the machine (MIM-91). Failures get logged but never block the user's tool call.

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
  hooks/hooks.json                           ← plugin-shipped lifecycle hooks
  commands/{mimir-install,mimir-update,mimir-disable,switch-model,...}.md   ← slash commands
  agents/                                    ← delegation workers (rendered from the prompt seed)
  src/                                       ← thin Claude Code wiring; the brain, stores, rules engine,
                                                cartographer client and MCP servers live in plugin-core
    cli.ts                                   ← subcommand dispatcher
    cli-args.ts                              ← install/update argument parsing
    install.ts                               ← fetch + convert + write (persona, output style, wrapper)
    project-settings.ts                      ← `enable` / `disable`: the per-project switch
    config.ts, logger.ts, boot-context.ts    ← shims binding plugin-core's shared modules to this host
    session-start-hook.ts, voice-anchor.ts, retrieve-hook.ts, file-context-hook.ts,
    rules-hook.ts, edit-guard-hook.ts, guard-hook.ts, verify-hook.ts,
    reindex-hook.ts, persist-hook.ts, precompact-hook.ts   ← one adapter per hook in hooks/hooks.json
    user-memory-mcp.ts, log-mcp.ts           ← entry points for the two plugin MCP servers
    delegate-command.ts, hygiene-command.ts, backfill-command.ts   ← human-driven subcommands
    agents.ts, worktree-bootstrap.ts, transcript-delta.ts
  artifacts/                                 ← templates bundled into the binary
    settings.json.template
    wrapper.sh.template
  dist/                                      ← gitignored, populated by ./build.sh
    darwin-arm64/mimir-cc
    linux-x64/mimir-cc
  build.sh
```
