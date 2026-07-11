---
description: Write the Mimir runtime state (system prompt, config, OpenCode agent, wrapper script, slash commands) to the user's home directory. Run after installing the plugin via `opencode plugin --global @RageLtd/mimir-oc`.
---

You are helping the user set up the Mimir runtime state on their machine.

## Before you start

The Mimir npm plugin is already installed and OpenCode is in PATH. This command is created by the first successful install; on a clean machine the user initiates that first install by asking OpenCode to call the `mimir_install` tool directly. Don't ask about either path. The only real prerequisite to verify before calling the install tool is the API key. Cartographer is auto-detected by the tool; do not infer that omission means it is unavailable.

1. **`MIMIR_API_KEY`** in the environment. The cloud server's `/v1/system-prompt` endpoint requires a bearer token. The install tool will surface a clear error if it's absent — if so, tell the user to `export MIMIR_API_KEY=...` and re-run.

If the user has not yet installed the plugin package itself, that's a separate step. Point them at `opencode plugin --global @RageLtd/mimir-oc` and the `~/.npmrc` GitHub Packages configuration in the README. But that step is *not* your concern for this command.

## Resolve the parameters

Use these values:

- **Server URL** — default `https://mimir.rageltd.ca` (the cloud host). A self-hosted install would use a different URL.
- **User memory DB path** — optional override. Omit it to use the default absolute path under `~/.mimir`; do not pass the literal string `~/.mimir/user-memories.db`.
- **Cartographer binary path** — optional override only. The install tool auto-detects `cartographer` from `PATH`, then checks `~/.local/bin/cartographer` for editor-launched environments with a reduced `PATH`. Do not ask for this path unless the user wants to override detection.
- **API key** — defaults to the `MIMIR_API_KEY` env var. Rarely needs to be passed explicitly.

Use the defaults unless the user has already supplied an override. Omit `userMemoryDb` to select its default rather than spelling the default with `~`. Do not ask for a Cartographer path: omit it and let the tool detect the binary. Only pass `cartographerBinary` when the user explicitly supplied a path.

## Run the install

Call the `mimir_install` tool with the gathered parameters.

## Report

Surface the tool's result to the user verbatim. On success, the result lists the files written. On failure, the result includes the actionable error — read it carefully and tell the user exactly what to fix (typically `export MIMIR_API_KEY=...` and retry, or fix the server URL).

The install writes the slash commands (`/mimir-install`, `/mimir-update`) to `~/.config/opencode/commands/` as part of its work, so the user can re-trigger the install or update from inside OpenCode in future sessions without re-reading this prompt.
