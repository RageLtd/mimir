# @RageLtd/mimir-oc

Mimir persona and runtime as an OpenCode plugin. Distributed via GitHub Packages as `@RageLtd/mimir-oc`; OpenCode installs it natively with `opencode plugin --global @RageLtd/mimir-oc`. The bundle is a single self-contained TS file (`dist/mimir-oc.ts`); the shared `@mimir/plugin-core` layer is inlined at build time, so the installed plugin has no runtime dependencies on the user's machine beyond OpenCode itself.

## Capabilities

The plugin matches the Mimir capabilities the cc-plugin exposes under Claude Code:

- **Persona system prompt** — `~/.mimir/system-prompt.md` is appended to every LLM call's system prompt. Markdown form, no XML conversion (the conversion is Claude-specific).
- **Voice anchor rotation** — on a fixed cadence (default every 5 turns, override `MIMIR_ANCHOR_INTERVAL`), injects a `<voice_anchor>` block into the recency slot to combat persona drift over long sessions.
- **Rules engine** — `.claude/**/*.enforce.toml` files in the project are evaluated on every tool call. Violations fail the call with the nudge as the error message.
- **Cartographer reindex** — on every file edit, spawns a one-shot cartographer reindex worker that parses the file and updates the local index (nothing leaves the machine). Full project reindex on session start.
- **User-memory tools** — seven in-process custom tools (`user_memory_search`, `user_memory_store`, `user_memory_list`, `user_memory_delete`, `user_profile_get`, `user_profile_add`, `user_profile_remove`) for recalling and storing facts about the developer. SQLite-backed at `~/.mimir/user-memories.db`.
- **Boot context** — on the first turn of a session, prepends a `<boot_context>` block (user profile + prior session context + project id) so the model reads the lead-in as the most recent content.
- **Local distillation (MIM-86)** — on session idle and before compaction, the new turns are extracted into the local memory replica on the developer's configured extraction model (`MIMIR_EXTRACTION_*`). The transcript never leaves the machine.
- **Install + update flow** — first-run setup is exposed as the `mimir_install` tool; a successful install materialises `/mimir-install` and `/mimir-update` for later runs. The plugin package itself is installed via `opencode plugin`.

## Install

The plugin is distributed via GitHub Packages. Configure the registry, install the package, set the API key, then ask OpenCode to call the first-run install tool. That successful run creates the reusable slash commands.

### 1. Configure the GitHub Packages registry (one-time)

Add the `@RageLtd` scope to your `~/.npmrc`. OpenCode 1.17.15's plugin installer uses npm's Arborist and npm configuration; it does not read `~/.bunfig.toml`:

```ini
@RageLtd:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

GitHub Packages requires a classic personal access token with the `read:packages` scope; fine-grained tokens are not supported. The token's account must also have read access to the private `RageLtd/mimir` repository. Export it in the shell that launches OpenCode:

```bash
export GITHUB_PACKAGES_TOKEN=ghp_...
```

### 2. Install the plugin

```bash
opencode plugin --global @RageLtd/mimir-oc
```

This is the OpenCode-native install — it resolves `@RageLtd/mimir-oc` through OpenCode's npm installer, adds it to the global OpenCode configuration's `plugin: [...]` field, and loads the plugin on next OpenCode startup. Without `--global`, OpenCode installs the plugin into the current project's configuration instead.

OpenCode supports both `~/.config/opencode/opencode.json` and `~/.config/opencode/opencode.jsonc` and merges them. Keep the `plugin` key in only one of them: if both files define it, one array can override the other. The Mimir runtime installer deliberately edits neither file.

Versions through `1.1.0` wrote a retired local-plugin reference during runtime installation. If `/mimir-install` is visible but reports that `mimir_install` is not exposed, inspect the effective configuration:

```bash
opencode debug config
```

Replace every legacy `file://~/.config/opencode/plugins/mimir-oc.ts` plugin entry with `@RageLtd/mimir-oc`, keeping the `plugin` key in only one global config file, then restart OpenCode. The slash command is discovered from `commands/` independently of the plugin, so seeing the command does not prove the package loaded.

You can verify by running `opencode` and checking that the Mimir tools (`user_memory_*`, `user_profile_*`, `mimir_install`) appear in the model's tool manifest.

OpenCode may report `Package has no TUI target to load in this app` after installation. That is informational: Mimir is a server/agent plugin, not a TUI-extension plugin. Restart OpenCode so the server target loads.

### 3. Set the API key and run the first install

```bash
export MIMIR_API_KEY=...
opencode
> Call the mimir_install tool using the default server URL.
```

The `mimir_install` tool writes the runtime state: the system prompt fetched from the server, `~/.mimir/config.json`, a stable CLI copy of the package at `~/.mimir/mimir-oc.ts`, the OpenCode custom agent at `~/.config/opencode/agents/mimir.md`, the wrapper script at `~/.local/bin/mimir`, and the slash commands at `~/.config/opencode/commands/`. It auto-detects Cartographer from `PATH` or `~/.local/bin/cartographer`, preserving an existing configured path when present. It does not rewrite OpenCode's config; `opencode plugin --global` owns the package registration.

After a successful first install, restart OpenCode so the slash commands and the new agent are picked up. `/mimir-install` is then available for repeat installs.

## Slash commands

The first successful install writes two slash commands to `~/.config/opencode/commands/`:

- **`/mimir-install`** — write the Mimir runtime state (system prompt, config, stable CLI bundle, custom agent, wrapper script, slash commands).
- **`/mimir-update`** — re-fetch the system prompt from the server and rewrite the local config. The install is idempotent.

## Wrapper script

`~/.local/bin/mimir` sets `MIMIR_ACTIVE=1` and execs `opencode` so any state checks in the plugin can distinguish a real Mimir session from a nested `opencode` subprocess.

```bash
export PATH="$HOME/.local/bin:$PATH"
mimir   # equivalent to `MIMIR_ACTIVE=1 opencode`
```

The wrapper also dispatches the E2E key ceremonies and manual sync without entering the editor — `mimir keys <status|setup|adopt|rotate|recovery-setup|recover>` and `mimir sync` run the plugin bundle directly via `bun` (the same shared plugin-core implementation as the Claude Code and ACP wrappers).

## Development

```bash
# from the monorepo root
bun install
bun run --filter @mimir/oc-plugin build
```

The bundled output is at `packages/oc-plugin/dist/mimir-oc.ts` — that's the artifact that ships to GitHub Packages.

## Release

Releases are automated. Conventional commits on `packages/oc-plugin/**` drive a semver bump via the shared `scripts/release-package.sh` at the repo root:

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

The in-monorepo package name (`@mimir/oc-plugin`) is renamed to the public scope (`@RageLtd/mimir-oc`) at publish time — only the published artifact carries the public name; the monorepo keeps its workspace-style name. The GitHub Release is for visibility — there's no asset to attach, the install is via `opencode plugin --global @RageLtd/mimir-oc`.
