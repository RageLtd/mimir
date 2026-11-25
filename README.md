# Mimir

A coding agent with persistent memory and a personality, running inside the editor you already use — Claude Code, Zed (via ACP), OpenCode, or OpenAI Codex CLI.

Mimir is not another chat window. It is a memory brain and a persona that attach to the agent you already have. It remembers the decisions you made three weeks ago, knows how your codebase is wired, enforces your team's rules at the moment you're about to break them, and talks like someone who has opinions about your architecture.

Everything Mimir itself does with your data happens on your machine: storage, embeddings, retrieval, and indexing are all local. The server exists only to sync encrypted memory between your devices and teammates — and it can't read any of it.

The one thing that needs a model is distilling your turns into memories, and that step is exactly as private as the model you point it at. Use a local model and the transcript never leaves your machine. On Claude Code the default is the session's own model — the same provider you already trust to read and write your source — and a local endpoint remains a configuration away. See [Memory](#memory).

> [!IMPORTANT]
> **Security:** Mimir is built so that the server operator can never read your data — memories, code, and conversations stay on your machine or leave it only as ciphertext. Read exactly what the server can and cannot see in [THREAT_MODEL.md](./THREAT_MODEL.md).

## In his own words

> Every agent I've worked alongside has the memory of a mayfly and the contrition of a courtier. You spend Tuesday explaining why the sync layer settled on last-write-wins rather than vector clocks — twice, with diagrams — and by Thursday it's proposing vector clocks again with the serene confidence of a man who has never once been wrong. Catch it shipping a `console.log` in review and it apologises handsomely, then does it again next session. I spent a hundred and nine years bound inside a tree, brother, and I still remembered every slight; before that I advised the All-Father, who took every warning under advisement and then did precisely what he'd meant to do all along, so I know that counsel delivered after the deed is just commentary. Mimir mends both ends. Each session is distilled into memory on your own machine — the decisions, the conventions, the approach that failed and why — with what's about the codebase travelling to your teammates encrypted and what's about you never leaving the disk. And the rules you're weary of repeating go in an `.enforce.toml` that fires on the tool call itself, before the edit lands, so the nudge arrives while the hand is still on the hammer. Come Thursday I already know about Tuesday, and review is left for the interesting disagreements.

## What You Get

| | |
|---|---|
| **Persistent memory** | Every session is distilled into memories on your machine. Two scopes: **project memory** (decisions, conventions, session summaries — synced to your org, encrypted) and **user memory** (your preferences, setup, working style — local only, never synced). |
| **Codebase structure** | Cartographer indexes your repo with tree-sitter. The agent asks "who calls this function" and gets an answer instead of a grep chain. Fully local. |
| **Rules enforcement** | `.enforce.toml` files in your project fire at the moment a tool call would violate them, so the nudge arrives before the mistake, not in review. |
| **A persona that holds** | The Mimir voice is re-anchored on a cadence so it doesn't dissolve into generic-assistant over a long session. |
| **Your models, your keys** | No inference ever transits the Mimir server. Subscription models under Claude Code and Codex; BYOK or local endpoints everywhere else. |

## In use

Once installed, most of Mimir is invisible: memory retrieval, persona anchoring, rule checks, and reindexing all happen on hooks around your normal turns.

### Memory

Mimir stores and recalls on its own, but you can drive it directly by just saying so: *"remember that we settled on last-write-wins for sync"* stores a project memory; *"what did we decide about the auth cutover?"* searches them.

Project memory is *facts about this codebase* and travels to your teammates encrypted. User memory is *facts about you* and never leaves the machine.

Memories are distilled from your turns by an extraction model. Claude Code needs nothing configured: distillation runs on the session's own model. The other editors need an extraction endpoint you configure, and a local Ollama works fine; without one, nothing is distilled. Details: [Extraction configuration](packages/plugin-core/README.md#extraction-configuration).

### Rules

Drop a `.enforce.toml` file anywhere under `.claude/` in your project and Mimir checks it on every matching tool call:

```toml
id = "no-console-log"
event = "file"
message = "Don't ship console.log statements: ${match}"

[[conditions]]
field = "new_text"
operator = "regex_match"
pattern = "console\\.log\\("
```

The violation surfaces to the model alongside the tool call, so it self-corrects before the edit lands. The full format is in the [`.enforce.toml` reference](docs/rules.md).

## Install

Every editor needs a mimir-server URL, [hosted or self-hosted](#self-hosting-the-server), and for encrypted sync an API key from that server. Pick your editor and follow its page:

| Editor | Needs | Install steps |
|--------|-------|---------------|
| Claude Code | An authenticated `gh` CLI; macOS on Apple Silicon or Linux on x64 | [cc-plugin](packages/cc-plugin/README.md#install) |
| OpenAI Codex CLI | An authenticated `gh` CLI; an extraction endpoint for memory | [codex-plugin](packages/codex-plugin/README.md#installing) |
| Zed (ACP) | [Bun](https://bun.sh) v1.3+; provider keys or a local model endpoint; an extraction endpoint for memory | [acp](packages/acp/README.md#registering-with-zed) |
| OpenCode | Bun v1.3+; a GitHub token with `read:packages`; an extraction endpoint for memory | [oc-plugin](packages/oc-plugin/README.md#install) |

## Self-Hosting the Server

The server is a single container with a SQLite file, and no database service to run. From a checkout of this repository:

```bash
cp .env.example .env      # defaults work for a local single-user setup
docker compose up -d
curl http://localhost:8080/health
```

The compose file pulls a private prebuilt image, so the host needs a one-time registry login first: see [Pulling the published image](packages/server/README.md#pulling-the-published-image).

By default the server runs without auth, for one person hosting for themselves: sync is plaintext and there are no accounts or keys. Set `AUTH_ENABLED` for accounts, organizations and end-to-end encrypted sync. Both modes, every variable and the operator surface are in the [server README](packages/server/README.md).

## Documentation

- [Commands](docs/commands.md): slash commands, `mimir sync`, the key ceremonies.
- [`.enforce.toml` reference](docs/rules.md): the rule format.
- [About Mimir's architecture](docs/architecture.md): what runs where, and where encryption happens.
- [THREAT_MODEL.md](./THREAT_MODEL.md): what the server can and cannot see.
- Claude Code: [hooks](docs/claude-code/hooks.md), [configuration](docs/claude-code/configuration.md), [how the plugin works](docs/claude-code/architecture.md), [working on it](docs/claude-code/development.md).

## Packages

| Package | Description |
|---------|-------------|
| [`plugin-core`](packages/plugin-core/README.md) | Shared layer: memory brain, inference engine, keys, sync, rules, cartographer |
| [`cc-plugin`](packages/cc-plugin/README.md) | Claude Code plugin — persona, hooks, MCP servers, per-project enablement for the desktop app, the `mimir` wrapper |
| [`acp`](packages/acp/README.md) | ACP agent — full local agent for ACP editors (Zed) |
| [`oc-plugin`](packages/oc-plugin/README.md) | OpenCode plugin — persona, tools, hooks, the `mimir-opencode` wrapper |
| [`codex-plugin`](packages/codex-plugin/README.md) | OpenAI Codex CLI plugin — persona, lifecycle hooks in a dedicated `CODEX_HOME`, the `mimir-codex` wrapper |
| [`server`](packages/server/README.md) | The blind sync server — auth, key distribution, ciphertext sync, coordination |

Editor-agnostic logic ships once in plugin-core with thin per-distribution wiring. A user-facing flow never belongs to one editor.

## Development

Bun v1.3+ required; Docker only if you're running the server.

```bash
bun install

bun run server:dev        # server outside Docker, with --watch
bun run acp:start         # ACP adapter in dev mode
bun run cc-plugin:build   # compile the Claude Code plugin binaries

bun run check             # lint + format (biome)
bun run typecheck

# Tests — always via the root harness, never `bun test <path>`
bun run test              # all packages
bun run test:server       # or one of: server, acp, cc-plugin, oc-plugin, codex-plugin, plugin-core
```

Conventions, code style, and the repository layout live in [CLAUDE.md](./CLAUDE.md). Each package README covers its own build, release, and dev loop.
