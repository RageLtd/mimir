---
description: Install Mimir for Claude Code — sets up ~/.mimir/, wrapper script, MCP servers, and lifecycle hooks
argument-hint: "[server-url]"
allowed-tools: ["Bash", "AskUserQuestion"]
---

You are installing the Mimir runtime for Claude Code. This is a one-shot setup that lands a wrapper script, MCP config, hook settings, runtime config, and the persona prompt onto the user's machine.

Carry out the following steps in order. Do not skip steps. Do not improvise alternatives.

## Step 1 — resolve the mimir-server URL

The user invoked this command with `$ARGUMENTS`. If `$ARGUMENTS` is non-empty, use it verbatim as the server URL and skip to Step 2.

If `$ARGUMENTS` is empty, call `AskUserQuestion` with one question:

- question: `Which mimir-server should this install point at?`
- header: `Server URL`
- options:
  - label: `https://mimir.rageltd.ca`, description: `Default — the shared alpha server`
  - label: `http://localhost:8080`, description: `Local dev server on this machine`

Use the user's selection (or their "Other" custom input) as the server URL. Bind the result to `<url>` for later steps.

## Step 2 — choose the user-memory database path

Call `AskUserQuestion`:

- question: `Where should the user-memory SQLite database live?`
- header: `Memory DB`
- options:
  - label: `~/.mimir/user-memories.db`, description: `Default — colocated with other Mimir state`
  - label: `Share with mimir-acp`, description: `Use the path mimir-acp already writes to (~/.mimir/user-memories.db)`

Both default options resolve to the same path; the second is there to flag the shared-DB use case to testers who already run mimir-acp. Bind the result to `<db-path>`. If the user picks "Other", expand any leading `~` to `$HOME` before using it.

## Step 3 — choose the cartographer binary path

Call `AskUserQuestion`:

- question: `Where is the cartographer binary on this machine?`
- header: `Cartographer`
- options:
  - label: `Skip — disable auto-reindex`, description: `(Recommended for now) The cartographer MCP server and PostToolUse reindex hook stay off until you wire up a binary path`
  - label: `Detect via $(which cartographer)`, description: `Resolve at install time. Fails clean if cartographer isn't on PATH`

If the user picks "Skip", bind `<carto-path>` to an empty string and continue.

If the user picks "Detect via $(which cartographer)", run `which cartographer` and capture the result. If empty, tell the user `cartographer not found on PATH — skipping`, bind `<carto-path>` to empty, and continue.

If the user picks "Other" and provides a path, bind that to `<carto-path>` after expanding leading `~`.

## Step 4 — fetch the mimir-cc binary

Run the plugin's binary fetcher. It detects the platform, downloads the matching `mimir-cc` release asset from the (private) `RageLtd/mimir` repo into `~/.local/bin/mimir-cc`, and on macOS re-signs it to clear Gatekeeper:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/ensure-binary.sh"
```

This needs the GitHub CLI (`gh`) installed and authenticated as an account with read access to `RageLtd/mimir` — alpha testers are repo collaborators, so they qualify. If `gh` is absent it falls back to `curl` + `$GITHUB_TOKEN`. Surface the script's output verbatim. If it exits non-zero — unsupported platform, no repo access, or no network and no existing binary — stop and let the user resolve the cause before retrying.

> **Developing the plugin locally?** Skip this step and build from source instead: `cd "${CLAUDE_PLUGIN_ROOT}" && ./build.sh`, then in Step 5 run `"${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc" install ...` instead of the installed binary. A marketplace clone can't build (it lacks the monorepo's dependency catalogs), which is why the default path downloads a released binary.

## Step 5 — run the installer binary

Build the argument list:

- positional: `<url>` from Step 1
- if `<db-path>` is non-empty AND differs from the default: append `--user-memory-db "<db-path>"`
- if `<carto-path>` is non-empty: append `--cartographer "<carto-path>"`

Run the binary Step 4 just installed:

```bash
"$HOME/.local/bin/mimir-cc" install "<url>" [optional flags]
```

Show the binary's stdout and stderr to the user verbatim.

## Step 6 — final instructions

If the binary exited zero, tell the user:

> Mimir is installed. Exit Claude Code and run `mimir` in any terminal to start a Mimir session. Make sure `~/.local/bin` is on your PATH.
>
> If you skipped the cartographer path and want auto-reindex later, re-run `/mimir-install` and provide a binary path — the install is idempotent.
>
> Hook logs land at `~/.mimir/logs/mimir-cc.log` — `tail -f` it if something misbehaves.

If the binary exited non-zero, surface its error output and do not invent a remediation — let the user decide.
