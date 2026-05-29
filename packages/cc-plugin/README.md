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
  mcp.json               ← MCP server config (mimir HTTP + user-memory stdio + optional cartographer)
  settings.json          ← hook config (voice-anchor, rules, reindex)
  config.json            ← runtime config consumed by the binary (server URL, DB path, cartographer path)
  user-memories.db       ← SQLite store backing the user-memory stdio MCP
  voice-state/           ← per-session anchor counters
  logs/mimir-cc.log      ← rolled append-only log from every hook + worker invocation
```

The wrapper invokes `claude --system-prompt-file ... --mcp-config ... --settings ...` so the Mimir persona replaces CC's default system prompt while the user's existing global CC settings stay untouched. `MIMIR_ACTIVE=1` is exported so hooks can distinguish a real Mimir turn from a nested `claude` subprocess that happens to inherit the same settings file.

## Install (alpha testers)

The plugin doesn't ship pre-built binaries — alpha testers build locally. It lives as the `@mimir/cc-plugin` package inside the `mimir` monorepo.

1. Clone the `mimir` monorepo somewhere persistent.
2. Install workspace dependencies and build the installer binary:

   ```bash
   bun install                              # from the monorepo root — hoists workspace deps
   bun run --filter @mimir/cc-plugin build  # or: cd packages/cc-plugin && ./build.sh
   ```

   This produces `packages/cc-plugin/dist/darwin-arm64/mimir-cc` and `packages/cc-plugin/dist/linux-x64/mimir-cc`. On Darwin the script also runs `codesign --sign - --force` against the macOS binary — Bun's `bun build --compile` emits a broken adhoc signature that Gatekeeper kills on exec with no stderr (exit 137), so the re-sign is mandatory.
3. Add the marketplace and install the plugin into Claude Code:

   ```
   /plugin marketplace add /path/to/mimir
   /plugin install mimir-cc
   ```

   The monorepo root ships a `.claude-plugin/marketplace.json` pointing at `./packages/cc-plugin`.
4. Inside Claude Code, run `/mimir-install`. The slash command asks for:
   - the mimir-server URL (default `https://mimir.rageltd.ca`),
   - where the user-memory SQLite DB should live (default `~/.mimir/user-memories.db`),
   - the path to your cartographer binary (default: skip, which disables the reindex hook).
5. Ensure `~/.local/bin` is on your `PATH`.
6. Exit Claude Code and run `mimir` from any terminal.

To re-install (e.g. to pick up a system-prompt update from the server), run `/mimir-update`. Without arguments it reuses the server URL stored in `~/.mimir/mcp.json`. When you update the plugin itself, rerun `./build.sh` so the installer binary matches.

## Supported platforms

Alpha ships `darwin-arm64` and `linux-x64` binaries only. Other platforms will error out of `/mimir-install`.

## What the install lands

### Hooks (settings.json)

Three hooks get wired into `~/.mimir/settings.json`:

- **`UserPromptSubmit` → voice-anchor.** Assembles the boot-context block (user profile, recent project memories, session context) on every prompt, and every N turns (default 5, override via `MIMIR_ANCHOR_INTERVAL`) injects a `<voice_anchor>` block sampled from the system prompt's voice library. Recency-slot persona refresh that counteracts long-context drift.
- **`PreToolUse` → rules.** Runs the rule engine against every `.claude/**/*.enforce.toml` file under the project root. On match, emits `additionalContext` with the violation message so the model sees the nudge alongside the tool call. See [Rules engine](#rules-engine).
- **`PostToolUse` (Edit | Write | MultiEdit) → reindex.** Spawns a detached cartographer worker that parses the changed file and syncs symbols + imports to mimir-server. Disabled when no cartographer binary is configured.

All three hooks are scoped to `MIMIR_ACTIVE=1` sessions and no-op silently in nested `claude` subprocesses.

### MCP servers (mcp.json)

- **`mimir`** (HTTP, always present). Connects to mimir-server's `/mcp` endpoint. Exposes Goldfish project memory, Cartographer codebase queries, introspection, and web search. Tools arrive prefixed as `mcp__mimir__*`.
- **`user-memory`** (stdio, always present). The `mimir-cc user-memory-mcp` subcommand. Exposes the local developer-scoped memory + profile store backed by `~/.mimir/user-memories.db`. Tools arrive prefixed as `mcp__user-memory__*`.
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

The `voice-anchor` subcommand runs as the `UserPromptSubmit` hook. Every prompt assembles the boot-context block — user profile and freeform memories from `~/.mimir/user-memories.db`, recent Goldfish project memories from mimir-server. Every `MIMIR_ANCHOR_INTERVAL` turns (default 5) it also samples one exchange from the system prompt's `<voice_in_action>` library and prepends a `<voice_anchor>` block to the user prompt.

State lives per-session at `~/.mimir/voice-state/<session-id>.json`. The hash-of-session-start offset prevents every fresh session from anchoring on turn 5 with the same exchange.

## Cartographer reindex

When `--cartographer PATH` was provided at install, the `PostToolUse` reindex hook fires on every Edit/Write/MultiEdit. The hook itself is a fast detached fork — spawns `mimir-cc reindex --worker <project> <file>` and exits 0 immediately so the next CC turn isn't blocked on a Rust binary plus an HTTP round-trip.

The worker spawns cartographer in `--parse-only` mode, parses the changed file, hashes the contents (SHA-256), and POSTs the result to mimir-server's `/v1/cartographer/sync` endpoint. Failures get logged but never block the user's tool call.

## Building

```bash
bun install                              # from the monorepo root — hoists workspace deps
bun run --filter @mimir/cc-plugin build  # or: cd packages/cc-plugin && ./build.sh
```

`dist/` is gitignored. The slash command resolves the binary at `${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc` at runtime, so a fresh clone needs `./build.sh` once before `/mimir-install` will work. The build step ad-hoc-signs the Darwin binary; without that, the binary dies with SIGKILL on every invocation. Moving to GitHub Releases (or in-Claude on-demand build) is future work.

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
