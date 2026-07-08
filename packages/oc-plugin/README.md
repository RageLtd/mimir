# @RageLtd/mimir-oc

Mimir persona and runtime as an OpenCode plugin. Distributed via GitHub Packages as `@RageLtd/mimir-oc`; OpenCode installs it natively with `opencode plugin @RageLtd/mimir-oc`. The bundle is a single self-contained TS file (`dist/mimir-oc.ts`); the shared `@mimir/plugin-core` layer is inlined at build time, so the installed plugin has no runtime dependencies on the user's machine beyond OpenCode itself.

## Capabilities

The plugin matches the Mimir capabilities the cc-plugin exposes under Claude Code:

- **Persona system prompt** — `~/.mimir/system-prompt.md` is appended to every LLM call's system prompt. Markdown form, no XML conversion (the conversion is Claude-specific).
- **Voice anchor rotation** — on a fixed cadence (default every 5 turns, override `MIMIR_ANCHOR_INTERVAL`), injects a `<voice_anchor>` block into the recency slot to combat persona drift over long sessions.
- **Rules engine** — `.claude/**/*.enforce.toml` files in the project are evaluated on every tool call. Violations fail the call with the nudge as the error message.
- **Cartographer reindex** — on every file edit, spawns a one-shot cartographer reindex worker that parses the file and syncs to the server. Full project reindex on session start.
- **User-memory tools** — seven in-process custom tools (`user_memory_search`, `user_memory_store`, `user_memory_list`, `user_memory_delete`, `user_profile_get`, `user_profile_add`, `user_profile_remove`) for recalling and storing facts about the developer. SQLite-backed at `~/.mimir/user-memories.db`.
- **Boot context** — on the first turn of a session, prepends a `<boot_context>` block (user profile + prior session context + project id) so the model reads the lead-in as the most recent content.
- **Local distillation (MIM-86)** — on session idle and before compaction, the new turns are extracted into the local memory replica on the developer's configured extraction model (`MIMIR_EXTRACTION_*`). The transcript never leaves the machine.
- **Install + update slash commands** — `/mimir-install` and `/mimir-update` for the runtime state; the plugin bundle itself is installed via `opencode plugin`.

## Install

The plugin is distributed via GitHub Packages. The install has three parts: configure the registry, install the plugin, set the API key, then run the slash command for the runtime state.

### 1. Configure the GitHub Packages registry (one-time)

Add the `RageLtd` scope to your `~/.bunfig.toml`:

```toml
[install.scopes]
"RageLtd" = { url = "https://npm.pkg.github.com", token = "$GITHUB_TOKEN" }
```

You'll need a GitHub personal access token with the `read:packages` scope. Fine-grained tokens work; classic tokens with `repo` are also fine.

### 2. Install the plugin

```bash
opencode plugin @RageLtd/mimir-oc
```

This is the OpenCode-native install — it runs `bun add @RageLtd/mimir-oc`, updates your `~/.config/opencode/opencode.json` `plugin: [...]` field, and loads the plugin on next OpenCode startup.

You can verify by running `opencode` and checking that the Mimir tools (`user_memory_*`, `user_profile_*`, `mimir_install`) appear in the model's tool manifest.

### 3. Set the API key and run the slash command

```bash
export MIMIR_API_KEY=...
opencode
> /mimir-install
```

`/mimir-install` writes the runtime state: the system prompt fetched from the server, `~/.mimir/config.json`, the OpenCode custom agent at `~/.config/opencode/agents/mimir.md`, the wrapper script at `~/.local/bin/mimir`, and the slash commands at `~/.config/opencode/commands/`. The slash command itself is the only thing in this install flow that the user runs from inside OpenCode.

After a successful install, restart OpenCode so the slash commands and the new agent are picked up.

## Slash commands

The install writes two slash commands to `~/.config/opencode/commands/`:

- **`/mimir-install`** — write the Mimir runtime state (system prompt, config, OpenCode config, custom agent, wrapper script).
- **`/mimir-update`** — re-fetch the system prompt from the server and rewrite the local config. The install is idempotent.

## Wrapper script

`~/.local/bin/mimir` sets `MIMIR_ACTIVE=1` and execs `opencode` so any state checks in the plugin can distinguish a real Mimir session from a nested `opencode` subprocess.

```bash
export PATH="$HOME/.local/bin:$PATH"
mimir   # equivalent to `MIMIR_ACTIVE=1 opencode`
```

## Development

```bash
# from the monorepo root
bun install
bun run --filter @mimir/oc-plugin build
```

The bundled output is at `packages/oc-plugin/dist/mimir-oc.ts` — that's the artifact that ships to GitHub Packages.

## Release

Releases are automated. Conventional commits on `packages/oc-plugin/**` drive a semver bump via `packages/oc-plugin/scripts/release.sh`:

- `feat!:` or `BREAKING CHANGE` → major
- `feat:` → minor
- `fix:|refactor:|perf:|revert:|build:` → patch
- `docs:|chore:|test:|style:|ci:` → no release

To cut a release:

```bash
# 1. Commit with a conventional-commit message and push to main.
git commit -m "feat: wire file-context augmentation into read tool"
git push origin main
# 2. The .github/workflows/oc-plugin-release.yml workflow:
#    a. version-bump: analyses the commits, bumps the version in
#       package.json, commits chore(release): oc-plugin v<version>,
#       creates the oc-plugin/v<version> tag, pushes both.
#    b. build: builds the bundle, verifies the size tripwire.
#    c. publish: renames the package to @RageLtd/mimir-oc, runs
#       `bun publish` against GitHub Packages, creates a GitHub
#       Release on the new tag.
```

The in-monorepo package name (`@mimir/oc-plugin`) is renamed to the public scope (`@RageLtd/mimir-oc`) at publish time — only the published artifact carries the public name; the monorepo keeps its workspace-style name. The GitHub Release is for visibility — there's no asset to attach, the install is via `opencode plugin @RageLtd/mimir-oc`.
