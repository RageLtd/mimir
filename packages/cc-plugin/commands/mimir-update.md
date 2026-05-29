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

If it exists, run the binary with the `update` subcommand and no URL argument — it will recover the URL from the existing config:

```bash
"${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc" update
```

This path preserves the existing `userMemoryDb` and `cartographerBinary` settings. Skip to Step 4.

If the config file does not exist, call `AskUserQuestion` to obtain the URL exactly as `/mimir-install` does (default `https://mimir.rageltd.ca`, alternative `http://localhost:8080`). You may also want to re-prompt for DB path and cartographer binary if the user is moving from a pre-config-file install — but treat this as the rare case.

## Step 2 — detect the platform

Run `uname -sm`. Map to `darwin-arm64` or `linux-x64` as in `/mimir-install`. Stop on unsupported platforms.

## Step 3 — rebuild the installer binary

The dist binary is built from local source. A stale binary silently installs old code — running update against a binary older than HEAD undoes any recent commits. Always rebuild before invoking the installer:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && ./build.sh
```

`build.sh` uses `set -euo pipefail` and exits non-zero on any failure. Surface the build output verbatim. If the build fails, stop and let the user fix the cause before retrying — common failure is `bun: command not found`, meaning Bun isn't on PATH on this machine.

If the build succeeds, the `dist/<platform>/mimir-cc` binary is guaranteed fresh; continue to Step 4.

## Step 4 — run the installer binary

If you obtained the URL in Step 1 (no existing config):

```bash
"${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc" update "<url>"
```

If you recovered from existing config:

```bash
"${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc" update
```

Show the binary's output verbatim.

## Step 5 — final instructions

If the binary exited zero, tell the user:

> Mimir updated. Restart any running `mimir` sessions to pick up the new system prompt and config.

If the binary exited non-zero, surface its error output without invented remediations.
