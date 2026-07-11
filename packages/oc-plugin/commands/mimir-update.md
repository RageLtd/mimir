---
description: Re-fetch the Mimir system prompt from the server and update the local config. Use this when the server-side system prompt has changed (new persona lines, updated rules, etc.).
---

You are helping the user update Mimir to pick up the latest server-side changes.

The update is the same operation as `/mimir-install`, just scoped to the runtime state. The npm package registration in OpenCode's config is not touched; update the package separately with `opencode plugin --global --force @RageLtd/mimir-oc`.

## Before you start

The same prerequisites as `/mimir-install` apply:

1. **MIMIR_API_KEY** must be in the environment. The cloud server's `/v1/system-prompt` endpoint requires a bearer token.
2. The `@RageLtd/mimir-oc` package must still be registered in OpenCode.

## Run the update

Read the existing config at `~/.mimir/config.json` to get the current `serverUrl`, `userMemoryDb`, `cartographerBinary`, and `apiKey` (if any). Then call the `mimir_install` tool with those values. If `cartographerBinary` is absent, omit it: the tool auto-detects from `PATH` and `~/.local/bin/cartographer`.

The install is idempotent — it overwrites the existing files with whatever the server returns now. Re-fetching the system prompt is the whole point of this command.

## Report

Surface the install tool's result to the user verbatim. On success, the result lists the files rewritten. On failure, the result includes the actionable error — read it carefully and tell the user exactly what to fix.
