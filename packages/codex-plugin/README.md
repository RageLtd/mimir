# @mimir/codex-plugin

Mimir for OpenAI Codex CLI — the fourth distribution alongside cc-plugin
(Claude Code), oc-plugin (OpenCode), and acp (Zed). Codex hosts its own
models; Mimir contributes the brain: persona, MCP tools, local memory
distillation, retrieval injection, cartographer indexing, and rule
nudges, all wired through Codex's lifecycle hooks (a structural clone of
Claude Code's — verified on codex-cli 0.144.0).

## Installing

Primary path — the codex plugin bootstrap. Codex plugins *can* bundle
lifecycle hooks, but Mimir deliberately doesn't ship its runtime that
way: a dedicated `CODEX_HOME` keeps the user's own `~/.codex` untouched
and lets the installer trust its hooks automatically through
`codex app-server`. So the plugin carries only skills — the install
skill drives the real installer. The repo's marketplace lives at
`.agents/plugins/marketplace.json` (marketplace name `mimir`, plugin
`mimir`):

```
codex plugin marketplace add RageLtd/mimir
codex plugin add mimir@mimir
```

then tell codex to "install mimir". The skill downloads the released
binary via `scripts/ensure-binary.sh codex` (your own `gh` auth — the
repo is private, collaborators only) and runs
`mimir-codex-bin install <server-url>`.

Fallback without the plugin system:

```
gh release download --repo RageLtd/mimir -p "mimir-codex-bin-<platform>" \
  -O ~/.local/bin/mimir-codex-bin && chmod +x ~/.local/bin/mimir-codex-bin
mimir-codex-bin install <mimir-server-url>
```

Self-update: the `mimir-codex` and `mimir-codex-acp` wrappers run
`~/.mimir/ensure-binary.sh codex` on every launch, so new
`codex-plugin/v*` releases land on their own. `codex plugin marketplace
upgrade` refreshes the bootstrap skill
itself. Releases are auto-versioned from conventional commits by
`.github/workflows/codex-plugin-release.yml` (bumps `plugin.json` — the
canonical root manifest with OpenAI settings under
`extensions.com.openai` — tags `codex-plugin/v<version>`, publishes
`mimir-codex-bin-{darwin-arm64,linux-x64}` assets).
`scripts/ensure-binary.sh` here is a drift-tested mirror of the
canonical copy in plugin-core.

## How it lands on a machine

`mimir-codex-bin install <mimir-server-url>` materialises:

- `~/.mimir/codex/` — a **dedicated CODEX_HOME**: mimir-owned
  `config.toml` (MCP servers, hooks, trust ledger) and `AGENTS.md` (the
  persona, fetched from `/v1/system-prompt` and converted with
  toAnthropicXml so voice-anchor parsing works). The user's own
  `~/.codex` is never touched.
  Codex feature flags use Codex's defaults, including `code_mode_host`.
- `~/.mimir/config.json` — the shared runtime config, **merged** over
  whatever another distribution already wrote.
- `~/.local/bin/mimir-codex` — wrapper: exports `CODEX_HOME` +
  `MIMIR_ACTIVE`, links `auth.json` from `~/.codex` when one exists (login
  is shared), exports `MIMIR_API_KEY` from config for the HTTP MCP entry,
  dispatches `keys`/`sync` to the binary, then `exec codex "$@"`.

### Login

The managed `config.toml` pins `cli_auth_credentials_store = "file"`.
Vanilla Codex defaults to the OS keyring on macOS, and keyring entries are
keyed per `CODEX_HOME`, so the isolated home could never see that login
and there is no `~/.codex/auth.json` to link. In that case the wrapper
says so and lets Codex prompt: run `mimir-codex login` once and the
credential is stored in `~/.mimir/codex/auth.json`. On Linux (file store
by default) the existing `~/.codex/auth.json` is linked in and nothing
needs doing.
- `~/.local/bin/mimir-codex-acp` — Zed agent-panel ACP wrapper: uses the
  same isolated Codex home, login, MCP configuration, hooks, and updater,
  then launches `@agentclientprotocol/codex-acp` through `bunx`.
- `~/.local/bin/mimir-codex-bin` — this package's compiled binary.

### Hook trust

Codex silently skips hooks until each definition is trusted. The
installer drives `codex app-server` (JSON-RPC `hooks/list`) to obtain
every hook's identity hash and appends `[hooks.state]` entries with
`trusted_hash` to config.toml. Any change to a hook definition
(including timeouts) changes its hash — re-run
`mimir-codex-bin update` after editing hooks.

`[hooks.state]` is Codex's internal trust store, not a documented
contract (openai/codex#21615 asks for a supported installer path and
notes the key format is private). It is defined in
`codex-rs/config/src/hook_config.rs` as of the current `main` and read
from the user config layer, which is exactly what `~/.mimir/codex/config.toml`
is. If a future Codex moves it, hooks go dark rather than failing: the
startup warning will say to open `/hooks`, and trusting them there is the
manual fallback.

## Hook legs

| Event | Subcommand | Purpose |
| --- | --- | --- |
| SessionStart | `session-start` | key reconcile + org sync (bounded), detached full cartographer reindex |
| UserPromptSubmit | `voice-anchor` | first-turn boot context + always-on `.claude/rules/**/*.md` block, periodic persona anchors |
| UserPromptSubmit | `retrieve` | per-turn local replica retrieval → additionalContext |
| PreToolUse | `rules` | `.enforce.toml` rule nudges (apply_patch fans out per file via tool-map) |
| PreToolUse (`^Bash$`) | `file-context` | cartographer + memory injection on single-file read commands, plus path-scoped (`paths:` frontmatter) project rules the first time a matching file is read |
| PostToolUse (`^apply_patch$`) | `reindex` | detached per-file cart-index upsert |
| Stop | `persist` | rollout-delta → local extraction → replica (MIM-86) |
| PreCompact | `precompact` | summary + fact distillation before discard |

Codex-specific translation lives in two modules: `rollout-delta.ts`
(Codex's `response_item` rollout JSONL → ModelMessages, with scaffolding
filters and per-session watermarks) and `tool-map.ts` (Codex tool shapes
→ CC-equivalents: `apply_patch` patch-header parsing, Bash read-command
parsing; Codex names its shell tool "Bash", so command detectors work
untranslated).

## Dev loop

```
scripts/dev-install.sh [<server-url>]   # build + land binary + install/update
bun run test:codex-plugin               # from repo root
```

dev-install pins dev mode (`~/.mimir/.codex-dev`) so the wrapper's
on-launch update check won't download a release over your local build.
Resume tracking releases with
`rm ~/.mimir/.codex-dev && ~/.mimir/ensure-binary.sh codex`.

Test fixtures under `test-fixtures/` were captured live from
codex-cli 0.144.0 (rollout JSONL + hook stdin payloads).
