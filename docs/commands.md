# Commands

The commands Mimir adds, inside the editor and in a terminal. Each editor's
own page lists anything specific to it:
[Claude Code](../packages/cc-plugin/README.md#commands),
[OpenCode](../packages/oc-plugin/README.md#slash-commands),
[Codex CLI](../packages/codex-plugin/README.md),
[Zed (ACP)](../packages/acp/README.md).

## Slash commands

| Command | Editors | What it does |
|---------|---------|--------------|
| `/mimir-install` | Claude Code, OpenCode | Write the runtime state: system prompt, config, MCP wiring, hooks |
| `/mimir-update` | Claude Code, OpenCode | Re-fetch the system prompt and re-land the runtime |
| `/delegate` | Claude Code, OpenCode | Run a change through the worker loop: plan, red test, implementation, cold review, with the verify gate on every hand-back |
| `/run-hygiene` | Claude Code | Sweep the local replica: consolidate near-duplicates, demote contradictions, prune stale facts. Dry-run by default; `--live` applies |
| `/refactor` | Claude Code, OpenCode, Codex (a skill in each) | Make code smaller and simpler without changing what it does |

`/refactor` is one of a set of skills the Claude Code, OpenCode and Codex
plugins ship: guidance the agent loads when it writes tests, tickets,
documentation or code comments.

## Terminal commands

Run these from the wrapper for your editor: `mimir` for Claude Code,
`mimir-opencode`, `mimir-codex`, or `bun run packages/acp/index.ts` for ACP.
The examples use `mimir`.

```bash
mimir sync                    # pull, apply, push — plus embedding backfill
mimir keys status             # what this device holds
mimir keys setup              # first device — prints your device secret EXACTLY ONCE
mimir keys adopt              # bring a new device online with that secret
mimir keys rotate             # rotate the org key (revokes removed members)
mimir keys recovery-setup     # create the org recovery keypair
mimir keys recover            # recover with it
```

> [!WARNING]
> The device secret is printed **exactly once**. Store it in your password manager immediately — it is the only way onto a new device or out of a lost keychain.

What each key ceremony does is in
[Keys and sync](../packages/plugin-core/README.md#keys-and-sync).

## When sync runs

Sync runs automatically at session boot and after each turn's distillation.
Run `mimir sync` when you want it now, or want the embedding backfill.

Headless environments without a keychain set `MIMIR_KEY_PASSPHRASE` to use an
encrypted-file fallback for the device secret.

Against a server with auth disabled, the same sync protocol runs in plaintext
mode, with no keys and no ceremonies.
