# @mimir/cc-plugin

Claude Code plugin that runs vanilla Claude Code as Mimir. The plugin ships the persona, the lifecycle hooks and the local MCP servers; an installer lands the `mimir-cc` binary behind them. Mimir runs on your Claude Code subscription, not through the Agent SDK and its usage caps.

There are two ways to run it:

- in the **Claude desktop app**, or a plain `claude`, in any project where you have enabled the plugin;
- with the `mimir` **wrapper** in a terminal.

## Requirements

- **Claude Code 2.1.319 or later.**
- **macOS on Apple Silicon or Linux on x64.** Releases ship `darwin-arm64` and `linux-x64` binaries only; `/mimir-install` fails on other platforms.
- **The GitHub CLI (`gh`), authenticated.** Release binaries live in the private `RageLtd/mimir` repository, and `/mimir-install` fetches them with your own `gh` credentials, so you need read access to it and an active login:

  ```bash
  gh auth login
  ```

  Without `gh`, the download falls back to `curl` with `$GITHUB_TOKEN`.
- **`~/.local/bin` on your `PATH`.** The `mimir` wrapper and the `mimir-cc` binary land there.
- **A mimir-server URL**, and an API key in `MIMIR_API_KEY` if that server has auth enabled.

## Install

1. Add RageLtd's plugin marketplace. The argument is `owner/repo` on GitHub; the marketplace registers under the name `rageltd`:

   ```
   /plugin marketplace add RageLtd/claude-plugins
   ```

2. Install the plugin. The `@rageltd` suffix is the marketplace name, not the GitHub owner:

   ```
   /plugin install mimir-cc@rageltd
   ```

3. Run the installer inside Claude Code:

   ```
   /mimir-install
   ```

   It asks for the mimir-server URL (default `https://mimir.rageltd.ca`), the user-memory database path (default `~/.mimir/user-memories.db`), and whether the server needs an API key, which it reads from `MIMIR_API_KEY` and never asks you to paste. It then downloads the `mimir-cc` binary, cartographer and the local embedder, writes `~/.mimir/` and the wrapper, and offers to enable the project you are in.

4. Start a session, in either of the two ways below.

## Run

### In the desktop app or a plain `claude`

Enable Mimir for a project, from inside it:

```bash
~/.local/bin/mimir-cc enable
```

Then open a new session in that project. The persona, hooks and MCP servers load wherever the plugin is enabled and nowhere else. `mimir-cc disable`, or `/mimir-disable` inside a session, reverses it.

For Mimir to stay out of your other projects, do not enable the plugin in `~/.claude/settings.json`.

The plugin's slash commands are not loaded in a project where it is disabled, so run `mimir-cc enable` from a terminal or from any session's Bash.

### With the wrapper

```bash
mimir
```

The wrapper checks for a binary update, then starts Claude Code with Mimir's own settings file, leaving your global settings untouched. Flags pass straight through to `claude`: `mimir --continue`, `mimir --resume <id>`, `mimir --model <model>`.

### Resuming and Remote Control

Any session in an enabled project is Mimir however it was started.

- **Resume however you like.** `mimir --continue`, a bare `claude --resume`, or resuming from the desktop app all reopen the transcript with the same plugin and persona.
- **Remote Control, interactive mode.** `mimir --rc`, or `/rc` inside a running session, attaches Remote Control to the running process, so claude.ai/code and the mobile app drive the same Mimir session. Keep the process alive (tmux over ssh, say) and accept the workspace-trust dialog in that directory once beforehand.
- **Remote Control, server mode.** `claude remote-control` spawns fresh sessions without the wrapper's flags; in an enabled project they behave like desktop-app sessions.

## Update

Run `/plugin marketplace update rageltd` to refresh the pinned release, then `/mimir-update` to re-fetch the binary and re-land the runtime. Without arguments `/mimir-update` reuses the server URL in `~/.mimir/config.json`.

After that first update you rarely need to. The installer turns on auto-update for the `rageltd` marketplace, and at every session start the plugin fetches the binary released under its own version, so the plugin and its binary move together. What changed between releases is on each `cc-plugin/v<version>` GitHub Release.

## Commands

Slash commands inside Claude Code:

| Command | What it does |
|---------|--------------|
| `/mimir-install` | Land the runtime (binary, system prompt, cartographer, wrapper) and offer to enable the current project |
| `/mimir-update` | Re-fetch the binary and re-land the runtime |
| `/mimir-disable` | Turn Mimir off for the current project |
| `/delegate <task or plan file>` | Run a change through the worker loop: plan, red test, implementation, cold review, with the verify gate on every hand-back |
| `/run-hygiene` | Sweep the local memory replica: consolidate near-duplicates, demote contradicted facts, prune stale ones. Dry-run by default; `--live` applies |
| `/add-grammar <language> [repo-url]` | Add a tree-sitter grammar so Mimir can index another language, then re-index the current project |

Terminal commands:

| Command | What it does |
|---------|--------------|
| `mimir-cc enable [--project DIR] [--plugin KEY]` | Turn Mimir on for a project; `disable` reverses it |
| `mimir keys <status\|setup\|adopt\|rotate\|recovery-setup\|recover>` | End-to-end encryption key ceremonies against an auth-enabled server |
| `mimir sync` | Pull, apply and push org memories, including the embedding backfill |
| `mimir-cc hygiene [--live] [--model <id>]` | The same sweep `/run-hygiene` drives |
| `mimir-cc embed-backfill` | Vectorize replica memories that lack embeddings |

`mimir keys setup` prints your **device secret exactly once**. Store it in your password manager; it is the only way to bring a new device online. The key hierarchy and the `MIMIR_KEY_PASSPHRASE` fallback are in [Keys and sync](../plugin-core/README.md#keys-and-sync).

## Skills

The plugin ships skills that the agent loads when the task calls for one. You can also invoke one by name, such as `/refactor <what>`:

| Skills | For |
|--------|-----|
| `unit-testing`, `integration-testing`, `end-to-end-testing`, `ui-testing` | Writing and reviewing tests |
| `bug-tickets`, `story-tickets`, `task-tickets`, `epic-tickets` | Writing and updating tickets |
| `documentation`, `code-comments` | Writing documentation and comments |
| `refactor` | Making code smaller and simpler without changing what it does |

## More

- [About the Claude Code plugin](../../docs/claude-code/architecture.md): how a session becomes Mimir, what the installer lands, the MCP servers, cartographer.
- [Hooks reference](../../docs/claude-code/hooks.md): what each hook does.
- [Configuration](../../docs/claude-code/configuration.md): settings files, worker models, environment variables.
- [`.enforce.toml` reference](../../docs/rules.md): the rule format.
- [Working on the plugin](../../docs/claude-code/development.md): build from source, tests, release.
