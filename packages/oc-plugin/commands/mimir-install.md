---
description: Write the Mimir runtime state (system prompt, config, OpenCode agent, wrapper script, slash commands) to the user's home directory. Run after installing the plugin via `opencode plugin @RageLtd/mimir-oc`.
---

You are helping the user set up the Mimir runtime state on their machine.

## Before you start

The Mimir plugin is already installed and OpenCode is in PATH — the user got here by running `opencode` and typing `/mimir-install`, both of which require those preconditions. Don't ask about either. The only real prerequisite to verify before calling the install tool is the API key.

1. **`MIMIR_API_KEY`** in the environment. The cloud server's `/v1/system-prompt` endpoint requires a bearer token. The install tool will surface a clear error if it's absent — if so, tell the user to `export MIMIR_API_KEY=...` and re-run.

If the user has not yet installed the plugin package itself, that's a separate step. Point them at `opencode plugin @RageLtd/mimir-oc` (and the `~/.bunfig.toml` GitHub Packages scope config in the README). But that step is *not* your concern for this command.

## Gather the parameters

Ask the user for:

- **Server URL** — default `https://mimir.rageltd.ca` (the cloud host). A self-hosted install would use a different URL.
- **User memory DB path** — default `~/.mimir/user-memories.db`. Filesystem path for the SQLite user-memory store.
- **Cartographer binary path** — optional. Absolute path to the cartographer Rust binary. Omit to disable auto-reindex on file edits.
- **API key** — defaults to the `MIMIR_API_KEY` env var. Rarely needs to be passed explicitly.

Pre-fill the defaults and only ask for the values the user wants to override. Don't interrogate — accept defaults on enter.

## Run the install

Call the `mimir_install` tool with the gathered parameters.

## Report

Surface the tool's result to the user verbatim. On success, the result lists the files written. On failure, the result includes the actionable error — read it carefully and tell the user exactly what to fix (typically `export MIMIR_API_KEY=...` and retry, or fix the server URL).

The install writes the slash commands (`/mimir-install`, `/mimir-update`) to `~/.config/opencode/commands/` as part of its work, so the user can re-trigger the install or update from inside OpenCode in future sessions without re-reading this prompt.
