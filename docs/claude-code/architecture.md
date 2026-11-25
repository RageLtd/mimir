# About the Claude Code plugin

How a Claude Code session becomes Mimir, and why the plugin is put together
the way it is. For the steps to install and run it, see the
[cc-plugin README](../../packages/cc-plugin/README.md).

## Two sources

Everything a session needs to be Mimir loads from two places: the plugin
directory, and the files `/mimir-install` lands.

```
<plugin root>/                 ← what Claude Code loads where the plugin is enabled
  hooks/register.ts            ← hooks module: persona, boot context, retrieval, voice anchors,
                                  tool gates, session lifecycle
  hooks/hooks.json             ← names the module
  types/index.d.ts             ← the module's `$.state` contract
  .mcp.json                    ← mimir-local + mimir-logs stdio servers (the installed binary)
  agents/                      ← delegation workers
  skills/                      ← shared skills
  output-styles/mimir.md       ← the persona as a forced output style
  commands/                    ← slash commands

~/.local/bin/
  mimir                  ← wrapper script: binary update check, then exec claude --settings
  mimir-cc               ← compiled binary: install, hook handlers, MCP servers, enable/disable

~/.mimir/
  system-prompt.md       ← canonical Markdown fetched from mimir-server, shared across hosts
  cc/system-prompt.xml   ← Claude Code's XML rendering with host context: what the hooks module
                            composes into every session's system prompt
  settings.json          ← wrapper-only settings
  config.json            ← runtime config the binary reads
  user-memories.db       ← SQLite store behind the mimir-local MCP server
  logs/mimir-cc.log      ← log from every hook and worker invocation
```

The plugin must stay enabled wherever Mimir runs. Claude Code scopes plugin
enablement per settings file, and that scoping is the per-project switch.

## Why the plugin carries everything

The Claude desktop app's Code tab spawns `claude` with no flags. A session can
only become Mimir through what Claude Code loads on its own, and that is the
plugin. So the persona, the lifecycle hooks and the MCP servers all ship in
the plugin, and all of it loads wherever the plugin is enabled.

The same route covers Zed's Claude Code agent: its `claude-code-acp` adapter
drives the real binary through the Agent SDK with user, project and local
settings loaded, so an enabled project comes up as Mimir there too.

The wrapper adds nothing to the persona. It runs the binary update check, then
`exec`s `claude --settings ~/.mimir/settings.json`, so the user's global
settings stay untouched. That flag is the only thing separating a wrapper
session from a plain `claude` in an enabled project.

One consequence: a `claude` spawned from inside an enabled project also has
the plugin enabled, so its hooks fire in that nested session too.

## The persona

The hooks module's `prompt.compose` hook answers with the installed XML and
nothing else, so the Mimir prompt replaces Claude Code's in every session
where the plugin is enabled.

The plugin also ships the persona as a forced output style
(`output-styles/mimir.md`, `force-for-plugin: true`), which the engine applies
whenever the plugin is enabled. It carries the persona where an organization
passes the plugin's hooks over.

The two do not double up. The engine sends the style as an
`output_style_instructions` attachment, not a prompt section. Where the hook
has composed the persona, the module's `prompt.attachment` hook leaves that
attachment out, and the persona goes out once.

The two copies have different sources. The hook reads the installed copy,
fetched from the server. The style's text is the repository's prompt seed at
release time, with its own environment block saying it arrives as an output
style.

## Workers

The three delegation workers, `mimir-impl`, `mimir-test` and `mimir-review`,
ship as subagent files in the plugin's `agents/` directory and not in
`~/.mimir`. The plugin directory is what Claude Code re-reads on
`/reload-plugins`, on an agent-view respawn and on a desktop resume, so the
workers survive all three; definitions passed on argv survive none of them.

Each file is rendered from `packages/server/system-prompt.md`: the "how to do
work" sections plus a role contract, with no persona. The worker prompt
therefore tracks the plugin release, not the prompt the server serves.

Plugin agents cannot carry frontmatter hooks, so the role guard is the
plugin's `guard` hook. Because it ships in the plugin, the workers are guarded
in a plain `claude` or desktop-app session as well as under the wrapper. See
the [hooks reference](hooks.md#toolcall--mimir-cc-rules-and-mimir-cc-guard).

## MCP servers

Both servers are declared in the plugin's `.mcp.json` and run the installed
binary (`${HOME}/.local/bin/mimir-cc`, expanded by Claude Code). Because the
plugin provides them, Claude Code prefixes their tools with the plugin and
server names.

- **`mimir-local`** is the `mimir-cc user-memory-mcp` subcommand: the local
  memory brain. It exposes developer-scoped memory and profile tools
  (`user_memory_*`, `user_profile_*`), project memory and playbook tools
  (`project_memory_*`, `project_playbook_*`) over the local org replica, and
  the Cartographer tools over the local index. Tools arrive as
  `mcp__plugin_mimir-cc_mimir-local__*`.
- **`mimir-logs`** is the `mimir-cc log-mcp` subcommand: it reads the local
  plugin logs, for self-debugging. Tools arrive as
  `mcp__plugin_mimir-cc_mimir-logs__*`.

## Cartographer

Mimir owns the codebase index and uses the cartographer binary purely as a
parser. The installer lands the `cartographer-parse-only-<platform>` asset of
the latest `RageLtd/cartographer` GitHub release, the build without
cartographer's SurrealDB feature, into `~/.mimir/bin`, and refreshes it on
`update` when a newer release exists.

A cartographer already on the machine is not picked up: a binary Mimir did not
fetch is one it cannot keep current. `--cartographer PATH` is the only
override, for a local build.

The reindex and session-start hooks spawn the binary in `--parse-only` mode.
The worker parses the file, hashes its contents (SHA-256), and writes the
result to the local index that `mimir-local` serves from. Nothing leaves the
machine, and a failure is logged without blocking the tool call.

Cartographer parses six languages out of the box and loads any other
tree-sitter grammar from `~/.cartographer/grammars/<name>/` at startup.
`/add-grammar <language>` installs one: it builds the grammar with the
tree-sitter CLI, writes the `tags.scm` and `imports.scm` queries and the
`language.json` manifest, validates with `cartographer grammars` and
`cartographer parse`, and finishes with
`mimir-cc session-start --worker <project>`, the same full re-index that
session start runs. Every re-index spawns a fresh cartographer, so no new
session is needed for the grammar to take effect.

## The embedder

The installer downloads the embedder's `llama-server` in the GPU variant the
machine can run:

| Platform | Variant |
|----------|---------|
| Apple Silicon | Metal |
| Linux with an NVIDIA driver loaded | CUDA, chosen from the driver's version, runtime libraries bundled |
| Linux with the HIP 7 runtime installed | ROCm |
| Other Linux with a GPU | Vulkan |
| No usable GPU | CPU only |

`mimir-cc update` swaps variants when a runtime appears.
