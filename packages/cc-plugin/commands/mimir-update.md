---
description: Re-install Mimir — overwrites ~/.mimir/ and ~/.local/bin/{mimir,mimir-cc}
argument-hint: "[server-url]"
allowed-tools: ["Bash", "AskUserQuestion"]
---

You are re-installing the Mimir runtime. In alpha this is identical to `install` — it overwrites every file the original install landed. State files in `~/.mimir/voice-state/` and the log file at `~/.mimir/logs/mimir-cc.log` are left alone.

Carry out the following steps in order.

## Step 1 — resolve the mimir-server URL

If `$ARGUMENTS` is non-empty, use it verbatim and skip to Step 2.

Otherwise, check whether `~/.mimir/config.json` exists:

```bash
test -f "$HOME/.mimir/config.json" && echo found || echo missing
```

If it exists, you'll run `update` with no URL argument in Step 3 — the binary recovers the URL (and preserves the existing `userMemoryDb` and `cartographerBinary` settings) from the config. Bind `<url>` to empty and continue to Step 2.

If the config file does not exist, call `AskUserQuestion` to obtain the URL exactly as `/mimir-install` does (default `https://mimir.rageltd.ca`, alternative `http://localhost:8080`). You may also want to re-prompt for DB path and cartographer binary if the user is moving from a pre-config-file install — but treat this as the rare case.

## Step 2 — fetch the mimir-cc binary

Run the plugin's binary fetcher. It detects the platform, downloads the latest `mimir-cc` release asset from the (private) `RageLtd/mimir` repo into `~/.local/bin/mimir-cc`, and on macOS re-signs it:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/ensure-binary.sh"
```

This needs `gh` installed and authenticated as an account with read access to `RageLtd/mimir` (or `curl` + `$GITHUB_TOKEN` as a fallback). Surface the script's output verbatim. Stop on a non-zero exit.

> **Developing the plugin locally?** Use `scripts/dev-install.sh` — it builds from source, atomically swaps the binary over `~/.local/bin/mimir-cc`, and pins dev mode so the updater won't overwrite it. For a one-off, you can instead `cd "${CLAUDE_PLUGIN_ROOT}" && ./build.sh` then run `"${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc" update ...` directly.

## Step 3 — run the installer binary

If you obtained a URL in Step 1 (no existing config):

```bash
"$HOME/.local/bin/mimir-cc" update "<url>"
```

If you're recovering from existing config (no URL):

```bash
"$HOME/.local/bin/mimir-cc" update
```

Show the binary's output verbatim.

## Step 4 — final instructions

If the binary exited zero, tell the user:

> Mimir updated. Restart any running `mimir` sessions to pick up the new system prompt and config.

If the binary exited non-zero, surface its error output without invented remediations.
