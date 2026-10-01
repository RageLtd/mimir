---
description: Install Mimir for Claude Code — sets up ~/.mimir/, the wrapper script, the Mimir output style, and the binary behind the plugin's hooks and MCP servers
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
  - label: `https://mimir.rageltd.ca`, description: `Default — the shared server`
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

## Step 3 — API key

Call `AskUserQuestion`:

- question: `Does this mimir-server require an API key?`
- header: `API key`
- options:
  - label: `No — ungated server`, description: `Local dev or self-hosted servers without the API gate`
  - label: `Yes — server is gated`, description: `The installer reads the key from the MIMIR_API_KEY environment variable; you never paste it into chat`

If the user picks "No", continue to Step 4.

If the user picks "Yes", check whether the key is present **without printing its value**:

```bash
test -n "$MIMIR_API_KEY" && echo set || echo unset
```

- `set` — continue to Step 4. The installer binary reads `MIMIR_API_KEY` from the environment on its own; do **not** pass `--api-key` and do **not** echo, log, or otherwise output the key.
- `unset` — stop the install and tell the user:

  > This server needs an API key, and `MIMIR_API_KEY` isn't set in this environment. Set it so that new shells inherit it — add it to your shell profile (`export MIMIR_API_KEY=...` for bash/zsh, `set -Ux MIMIR_API_KEY ...` for fish) — then re-run `/mimir-install`. Don't paste the key into this chat: anything typed here is stored in the conversation transcript.

  Then end the turn. Do not ask for the key via `AskUserQuestion`, do not accept it as "Other" free text, and do not put it on any command line — those all persist the key in the transcript.

## Step 4 — fetch the mimir-cc binary

Run the plugin's binary fetcher. It detects the platform, downloads the matching `mimir-cc` release asset from the (private) `RageLtd/mimir` repo into `~/.local/bin/mimir-cc`, and on macOS re-signs it to clear Gatekeeper:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/ensure-binary.sh"
```

This needs the GitHub CLI (`gh`) installed and authenticated as an account with read access to `RageLtd/mimir` — repo collaborators qualify. If `gh` is absent it falls back to `curl` + `$GITHUB_TOKEN`. Surface the script's output verbatim. If it exits non-zero — unsupported platform, no repo access, or no network and no existing binary — stop and let the user resolve the cause before retrying.

> **Developing the plugin locally?** Skip this step and build from source instead: `cd "${CLAUDE_PLUGIN_ROOT}" && ./build.sh`, then in Step 6 run `"${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc" install ...` instead of the installed binary. A marketplace clone can't build (it lacks the monorepo's dependency catalogs), which is why the default path downloads a released binary. Once you've installed once, `scripts/dev-install.sh` is the fast iterate loop — it builds, atomically swaps the binary in, and pins dev mode so the updater won't overwrite your build.

## Step 5 — run the installer binary

Build the argument list:

- positional: `<url>` from Step 1
- if `<db-path>` is non-empty AND differs from the default: append `--user-memory-db "<db-path>"`
- only if the user explicitly asked to pin a cartographer binary: append `--cartographer "<path>"`
- never an `--api-key` flag — on gated servers the binary picks the key up from `MIMIR_API_KEY` in its environment (verified in Step 3)

Run the binary Step 4 just installed. It also fetches the embedder artifacts and the latest cartographer release — both need network access to GitHub:

```bash
"$HOME/.local/bin/mimir-cc" install "<url>" [optional flags]
```

Show the binary's stdout and stderr to the user verbatim.

## Step 6 — enable Mimir in this project (desktop app path)

If the binary exited non-zero, surface its error output, do not invent a remediation, and stop here.

Otherwise call `AskUserQuestion`:

- question: `Enable Mimir for this project now? This is how the Claude desktop app (and a plain `claude`) runs as Mimir — the plugin's hooks, MCP servers and persona load only in projects where it is enabled.`
- header: `Enable here`
- options:
  - label: `Yes — enable this project`, description: `Writes enabledPlugins + the Mimir output style into this project's .claude/settings.local.json (per-user, gitignored)`
  - label: `No — I'll use the mimir wrapper`, description: `Terminal only; nothing is written to this project`

If the user picks **Yes**, run:

```bash
"$HOME/.local/bin/mimir-cc" enable
```

Show its output verbatim — it names the settings file it wrote and, when the plugin is also enabled in `~/.claude/settings.json`, notes that this makes Mimir active in every project (the user decides whether to change that; do not edit that file for them).

## Step 7 — final instructions

Tell the user:

> Mimir is installed.
>
> - **Claude desktop app / plain `claude`:** open a new session in any project where you ran `mimir-cc enable`. To enable another project later, run `~/.local/bin/mimir-cc enable` from inside it (any session's Bash will do — the plugin's commands aren't loaded in projects where it's disabled); `mimir-cc disable` reverses it.
> - **Terminal:** run `mimir` for a session with the full persona prompt and `/switch-model`. Make sure `~/.local/bin` is on your PATH.
>
> Hook logs land at `~/.mimir/logs/mimir-cc.log` — `tail -f` it if something misbehaves.
