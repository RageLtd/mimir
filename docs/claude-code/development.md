# Working on the Claude Code plugin

How to build, install and test the Claude Code plugin from a checkout. It is
for contributors. To use the plugin, follow the
[cc-plugin README](../../packages/cc-plugin/README.md); the marketplace path
there needs no clone and no build.

The plugin is the `@mimir/cc-plugin` package in the monorepo. A marketplace
clone contains only that package and cannot build it, because it lacks the
monorepo's dependency catalogs. That is why the marketplace path ships a
prebuilt binary.

## Build

From the monorepo root:

```bash
bun install
bun run cc-plugin:build
```

This runs `packages/cc-plugin/build.sh` and produces
`packages/cc-plugin/dist/darwin-arm64/mimir-cc` and
`packages/cc-plugin/dist/linux-x64/mimir-cc`. `dist/` is gitignored.

On Darwin the script also runs `codesign --sign - --force` against the macOS
binary. `bun build --compile` emits a broken ad-hoc signature that Gatekeeper
kills on exec with no stderr (exit 137), so the re-sign is mandatory.

## Install from the checkout

1. Add the monorepo as a local marketplace and install from it. The monorepo
   root has a `.claude-plugin/marketplace.json` naming the `mimir-cc-local`
   marketplace, pointed at `./packages/cc-plugin`:

   ```
   /plugin marketplace add /path/to/mimir
   /plugin install mimir-cc@mimir-cc-local
   ```

2. Build once, as above. The slash command resolves the binary at
   `${CLAUDE_PLUGIN_ROOT}/dist/<platform>/mimir-cc`.

3. Run `/mimir-install` and point the installer at your local build; the
   slash command spells out how.

## Iterate

After the first install, use `scripts/dev-install.sh`. It rebuilds, atomically
swaps `~/.local/bin/mimir-cc`, and writes `~/.mimir/.cc-dev` to pin the dev
build, so `ensure-binary.sh` does not replace it with a release.

Delete `~/.mimir/.cc-dev` to resume tracking releases.

## Test

From the monorepo root:

| Command | Runs |
|---------|------|
| `bun run test:cc-plugin` | The package's Bun tests, named `*.spec.ts` |
| `bun run cc-plugin:mod:validate` | `claude plugin validate .`, which reads the hooks module the way the engine will |
| `bun run cc-plugin:mod:test` | `claude plugin test .`, the hooks module's kit tests, named `*.test.ts` |

The two suffixes are deliberate. `claude plugin test` sweeps every
`*.test.ts` under the plugin root, which is also the package root, so the Bun
tests use `*.spec.ts` to stay out of its way.

## Rendered files

Two sets of committed files are rendered from `packages/server/system-prompt.md`.
Re-render after editing the seed:

| Files | Command | Drift check |
|-------|---------|-------------|
| `agents/` (the delegation workers) | `bun run --cwd packages/cc-plugin agents:render` | `agents.spec.ts` |
| `output-styles/mimir.md` | `bun run --cwd packages/cc-plugin output-style:render` | `output-style.spec.ts` |

Re-render the agents after editing `packages/plugin-core/src/workers` too.

`scripts/ensure-binary.sh` is a byte-identical mirror of the canonical copy at
`packages/plugin-core/scripts/ensure-binary.sh`, kept here because the
marketplace clone contains only this package. Edit the plugin-core copy and
re-copy; a drift test checks the two match.

## Release

The `cc-plugin Release` workflow (`.forgejo/workflows/cc-plugin-release.yml`):

1. versions the package from conventional commits, through the shared
   `scripts/release-package.sh` at the repo root;
2. cross-compiles both platforms;
3. publishes the assets on a `cc-plugin/v<version>` tag;
4. dispatches an event to the `RageLtd/claude-plugins` marketplace to bump its
   pinned ref.

The marketplace pins the plugin to a `git-subdir` source: `packages/cc-plugin`
out of the `RageLtd/mimir` monorepo at the released tag. The compiled binary
is not in that clone; `scripts/ensure-binary.sh` downloads the matching
`mimir-cc-<platform>` release asset onto the user's machine.

## Layout

```
packages/cc-plugin/
  .claude-plugin/plugin.json   ← plugin manifest (marketplace.json is at the monorepo root)
  .mcp.json                    ← the plugin's MCP servers
  hooks/                       ← the hooks module, one file per concern; register.ts is the entry,
                                  hooks.json names it, *.test.ts are kit tests
  types/index.d.ts             ← the module's $.state contract
  commands/                    ← slash commands
  skills/                      ← shared skills, rendered from plugin-core
  agents/                      ← delegation workers, rendered from the prompt seed
  output-styles/mimir.md       ← the persona as a forced output style, rendered
  src/                         ← the mimir-cc binary: thin Claude Code wiring. The brain, stores,
                                  rules engine, cartographer client and MCP servers are in plugin-core
    cli.ts                     ← subcommand dispatcher
    install.ts                 ← fetch, convert and write the persona and wrapper
    project-settings.ts        ← enable / disable
    *-hook.ts                  ← the subcommands the hooks module runs
    user-memory-mcp.ts, log-mcp.ts   ← entry points for the two MCP servers
  artifacts/                   ← templates bundled into the binary
  scripts/                     ← dev-install, ensure-binary, the renderers
  build.sh
```
