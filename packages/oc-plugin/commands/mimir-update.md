---
description: Re-fetch the Mimir system prompt from the server and update the local config. Use this when the server-side system prompt has changed (new persona lines, updated rules, etc.).
---

You are helping the user update Mimir to pick up the latest server-side changes.

The update is the same operation as `/mimir-install`, just scoped to the runtime state. The plugin bundle at `~/.config/opencode/plugins/mimir-oc.ts` is **not** touched — that's a separate update the user does manually by downloading a new release.

## Before you start

The same prerequisites as `/mimir-install` apply:

1. **MIMIR_API_KEY** must be in the environment. The cloud server's `/v1/system-prompt` endpoint requires a bearer token.
2. The plugin bundle must still be at `~/.config/opencode/plugins/mimir-oc.ts`.

## Run the update

Read the existing config at `~/.mimir/config.json` to get the current `serverUrl`, `userMemoryDb`, `cartographerBinary`, and `apiKey` (if any). Then call the `mimir_install` tool with those values.

The install is idempotent — it overwrites the existing files with whatever the server returns now. Re-fetching the system prompt is the whole point of this command.

## Report

Surface the install tool's result to the user verbatim. On success, the result lists the files rewritten. On failure, the result includes the actionable error — read it carefully and tell the user exactly what to fix.
