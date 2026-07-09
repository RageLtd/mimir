# @mimir/cc-plugin

Alpha-stage Claude Code plugin that installs the Mimir persona, MCP wiring, and lifecycle hooks onto your machine, then exposes a `mimir` wrapper command that launches vanilla Claude Code as Mimir. Sidesteps Anthropic's SDK-usage caps by routing Mimir through the Claude Code subscription path instead of the Agent SDK.

## Architecture

The plugin's only job is to land files. Once `/mimir-install` has run, the runtime lives entirely under `~/.mimir/` and `~/.local/bin/{mimir,mimir-cc}`; the plugin itself can be uninstalled and `mimir` will keep working.

```
~/.local/bin/
  mimir                  ← wrapper script: exec claude with persona/MCP/hook flags
  mimir-cc               ← compiled binary: install + hook handlers + user-memory MCP

~/.mimir/
  system-prompt.md       ← fetched from mimir-server, XML-converted at install
  mcp.json               ← MCP server config (mimir-local + mimir-logs stdio, mimir HTTP, optional cartographer)
  settings.json          ← hook config (voice-anchor, rules, reindex)
  config.json            ← runtime config consumed by the binary (server URL, DB path, cartographer path)
  user-memories.db       ← SQLite store backing the user-memory stdio MCP
  voice-state/           ← per-session anchor counters
  logs/mimir-cc.log      ← rolled append-only log from every hook + worker invocation
```

The wrapper invokes `claude --system-prompt-file ... --mcp-config ... --settings ...` so the Mimir persona replaces CC's default system prompt while the user's existing global CC settings stay untouched. `MIMIR_ACTIVE=1` is exported so hooks can distinguish a real Mimir turn from a nested `claude` subprocess that happens to inherit the same settings file.

## Install (alpha testers)

There are two ways in. The **marketplace path** is the normal one — no clone, no local build; Claude Code pulls the plugin from GitHub and `/mimir-install` downloads a prebuilt binary. The **from-source path** is only for hacking on the plugin itself. Both converge on `/mimir-install`.

### Prerequisites

- **The GitHub CLI (`gh`), authenticated.** Release binaries live in the **private** `RageLtd/mimir` repo, and `/mimir-install` fetches them with your own `gh` credentials — so you need read access (alpha testers are repo collaborators, which qualifies) and an active login:

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

   It asks for three things — the mimir-server URL (default `https://mimir.rageltd.ca`), the user-memory SQLite DB path (default `~/.mimir/user-memories.db`), and the cartographer binary path (default: skip, which leaves the reindex hook off). Then `ensure-binary.sh` downloads the matching `mimir-cc-<platform>` asset from `RageLtd/mimir` releases, re-signs it on macOS to clear Bun's broken adhoc signature, and the installer writes out `~/.mimir/` plus the wrapper.

4. Exit Claude Code and run `mimir` from any terminal.

To track a newer release later, run `/plugin marketplace update rageltd` to refresh the pinned tag, then `/mimir-update` to re-fetch the binary and re-land the runtime (without arguments it reuses the server URL stored in `~/.mimir/mcp.json`). `ensure-binary.sh` also runs on every `mimir` launch, so simply starting the wrapper usually pulls the latest release on its own — unless you've pinned a dev build (see below).

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

Alpha ships `darwin-arm64` and `linux-x64` binaries only. Other platforms will error out of `/mimir-install`.

## Key ceremonies (`mimir keys`)

Against an auth-enabled server, E2E key material is managed with `mimir keys
<status|setup|adopt|rotate|recovery-setup|recover>` — the same commands work
from `mimir-acp keys …` and the OpenCode wrapper (the implementation is
shared in plugin-core; no editor owns it). `setup` prints your **device
secret exactly once** — store it in your password manager; it is the only
way to bring a new device online (`mimir keys adopt`).

The device secret lives in the OS credential store via `Bun.secrets`
(macOS Keychain Services / Linux libsecret / Windows Credential Manager).
macOS note: the keychain ACL binds to the `bun` binary — the first access
prompts once and covers all hook processes; upgrading Bun re-prompts once.
Headless/keychain-less environments set `MIMIR_KEY_PASSPHRASE` to use the
encrypted-file fallback at `~/.mimir/device-secret.enc`.

## What the install lands

### Hooks (settings.json)

Three hooks get wired into `~/.mimir/settings.json`:

- **`UserPromptSubmit` → voice-anchor.** Assembles the boot-context block (user profile, recent project memories, session context) on every prompt, and every N turns (default 5, override via `MIMIR_ANCHOR_INTERVAL`) injects a `<voice_anchor>` block sampled from the system prompt's voice library. Recency-slot persona refresh that counteracts long-context drift.
- **`PreToolUse` → rules.** Runs the rule engine against every `.claude/**/*.enforce.toml` file under the project root. On match, emits `additionalContext` with the violation message so the model sees the nudge alongside the tool call. See [Rules engine](#rules-engine).
- **`PostToolUse` (Edit | Write | MultiEdit) → reindex.** Spawns a detached cartographer worker that parses the changed file and updates the local cartographer index. Disabled when no cartographer binary is configured.

All three hooks are scoped to `MIMIR_ACTIVE=1` sessions and no-op silently in nested `claude` subprocesses.

### MCP servers (mcp.json)

- **`mimir-local`** (stdio, always present). The `mimir-cc user-memory-mcp` subcommand. Exposes the local memory brain: developer-scoped memory + profile tools (`user_memory_*`, `user_profile_*`) over `~/.mimir/user-memories.db`, and project memory + playbook tools (`project_memory_*`, `project_playbook_*`) over the local org replica. Tools arrive prefixed as `mcp__mimir-local__*`.
- **`mimir-logs`** (stdio, always present). The `mimir-cc log-mcp` subcommand — reads the local plugin logs for self-debugging. Tools arrive prefixed as `mcp__mimir-logs__*`.
- **`mimir`** (HTTP, always present). Connects to mimir-server's `/mcp` endpoint — introspection only (server logs, self-hosted). Tools arrive prefixed as `mcp__mimir__*`.
- **`cartographer`** (stdio, optional). The cartographer binary in `--parse-only` mode. Enabled when `--cartographer PATH` was passed at install time. Tools arrive prefixed as `mcp__cartographer__*`.

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

When `--cartographer PATH` was provided at install, the `PostToolUse` reindex hook fires on every Edit/Write/MultiEdit. The hook itself is a fast detached fork — spawns `mimir-cc reindex --worker <project> <file>` and exits 0 immediately so the next CC turn isn't blocked on a Rust binary plus an HTTP round-trip.

The worker spawns cartographer in `--parse-only` mode, parses the changed file, hashes the contents (SHA-256), and writes the result to the local cartographer index — nothing leaves the machine (MIM-91). Failures get logged but never block the user's tool call.

## Building

```bash
bun install                              # from the monorepo root — hoists workspace deps
bun run --filter @mimir/cc-plugin build  # or: cd packages/cc-plugin && ./build.sh
```

`dist/` is gitignored. For local development the slash command resolves the binary at `${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc`, so a fresh clone needs `./build.sh` once before `/mimir-install` will work. The build step ad-hoc-signs the Darwin binary; without that, the binary dies with SIGKILL on every invocation. For released installs the binary instead comes from `RageLtd/mimir` GitHub Releases: the `cc-plugin Release` workflow (`.github/workflows/cc-plugin-release.yml`) auto-versions from conventional commits, cross-compiles both platforms, publishes the assets on a `cc-plugin/v<version>` tag, and dispatches an event to the `RageLtd/claude-plugins` marketplace to bump its pinned ref. `scripts/ensure-binary.sh` is what pulls those assets onto the user's machine.

## Layout

```
packages/cc-plugin/                          ← workspace member @mimir/cc-plugin
  .claude-plugin/plugin.json                 ← plugin manifest (marketplace.json lives at monorepo root)
  commands/{mimir-install,mimir-update,switch-model}.md   ← slash commands
  src/
    cli.ts                                   ← subcommand dispatcher
    install.ts                               ← fetch + convert + write
    config.ts                                ← read/write ~/.mimir/config.json
    logger.ts                                ← append-only structured logger
    markdown-to-xml.ts                       ← canonical prompt → Anthropic XML
    boot-context.ts                          ← assemble user profile + memories
    voice-anchor.ts                          ← UserPromptSubmit hook
    rules-hook.ts                            ← PreToolUse hook adapter
    reindex-hook.ts                          ← PostToolUse hook + detached worker
    user-memory-mcp.ts                       ← stdio MCP server
    rules/                                   ← rule engine (loader, matcher, runner)
    cartographer/                            ← cartographer MCP client + sync
    store/                                   ← user-memory SQLite store
    tools/                                   ← user-memory MCP tool definitions
  artifacts/                                 ← templates bundled into the binary
    mcp.json.template
    settings.json.template
    wrapper.sh.template
  dist/                                      ← gitignored, populated by ./build.sh
    darwin-arm64/mimir-cc
    linux-x64/mimir-cc
  build.sh
```
