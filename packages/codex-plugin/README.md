# @mimir/codex-plugin

Mimir for OpenAI Codex CLI — the fourth distribution alongside cc-plugin
(Claude Code), oc-plugin (OpenCode), and acp (Zed). Codex hosts its own
models; Mimir contributes the brain: persona, MCP tools, local memory
distillation, retrieval injection, cartographer indexing, and rule
nudges, all wired through Codex's lifecycle hooks (a structural clone of
Claude Code's — verified on codex-cli 0.144.0).

## Installing

Primary path — the codex plugin bootstrap (the plugin can't carry hooks,
so it ships a single install skill that drives the real installer):

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

Self-update: the `mimir-codex` wrapper runs `~/.mimir/ensure-binary.sh
codex` on every launch, so new `codex-plugin/v*` releases land on their
own. `codex plugin marketplace upgrade` refreshes the bootstrap skill
itself. Releases are auto-versioned from conventional commits by
`.github/workflows/codex-plugin-release.yml` (bumps
`.codex-plugin/plugin.json`, tags `codex-plugin/v<version>`, publishes
`mimir-codex-bin-{darwin-arm64,linux-x64}` assets).
`scripts/ensure-binary.sh` here is a drift-tested mirror of the
canonical copy in plugin-core.

## How it lands on a machine

`mimir-codex-bin install <mimir-server-url>` materialises:

- `~/.mimir/codex/` — a **dedicated CODEX_HOME**: mimir-owned
  `config.toml` (MCP servers, hooks, trust ledger, `code_mode_host`
  pinned off) and `AGENTS.md` (the persona, fetched from
  `/v1/system-prompt` and converted with toAnthropicXml so voice-anchor
  parsing works). The user's own `~/.codex` is never touched.
- `~/.mimir/config.json` — the shared runtime config, **merged** over
  whatever another distribution already wrote.
- `~/.local/bin/mimir-codex` — wrapper: exports `CODEX_HOME` +
  `MIMIR_ACTIVE`, links `auth.json` from `~/.codex` (login is shared),
  exports `MIMIR_API_KEY` from config for the HTTP MCP entry, dispatches
  `keys`/`sync` to the binary, then `exec codex "$@"`.
- `~/.local/bin/mimir-codex-bin` — this package's compiled binary.

### Hook trust

Codex silently skips hooks until each definition is trusted. The
installer drives `codex app-server` (JSON-RPC `hooks/list`) to obtain
every hook's identity hash and appends `[hooks.state]` entries with
`trusted_hash` to config.toml. Any change to a hook definition
(including timeouts) changes its hash — re-run
`mimir-codex-bin update` after editing hooks.

## Hook legs

| Event | Subcommand | Purpose |
| --- | --- | --- |
| SessionStart | `session-start` | key reconcile + org sync (bounded), detached full cartographer reindex |
| UserPromptSubmit | `voice-anchor` | first-turn boot context, periodic persona anchors |
| UserPromptSubmit | `retrieve` | per-turn local replica retrieval → additionalContext |
| PreToolUse | `rules` | `.enforce.toml` rule nudges (apply_patch fans out per file via tool-map) |
| PreToolUse (`^Bash$`) | `file-context` | cartographer + memory injection on single-file read commands |
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
