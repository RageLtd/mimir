# Claude Code plugin configuration

The files and environment variables that configure Mimir under Claude Code.
To install the plugin, see the
[cc-plugin README](../../packages/cc-plugin/README.md).

## Files

| File | Written by | Holds |
|------|------------|-------|
| `~/.mimir/config.json` | `/mimir-install`, `/mimir-update` | Runtime config the binary reads: server URL, database path, cartographer path, worker models. Shared with the other distributions; see [Shared config](../../packages/plugin-core/README.md#shared-config) |
| `~/.mimir/settings.json` | `/mimir-install` | Claude Code settings the `mimir` wrapper passes with `--settings` |
| `<project>/.claude/settings.local.json` | `mimir-cc enable` | Plugin enablement for one project |
| `~/.mimir/mimir.toml`, `<project>/mimir.toml` | you | Developer preferences, such as worker models |

## Wrapper settings (`~/.mimir/settings.json`)

Used only by sessions started with the `mimir` wrapper. It carries:

- the subagent environment, including `CLAUDE_CODE_SUBAGENT_MODEL=opus`, so a
  subagent that is not a delegation worker (Explore, the docs guide) defaults
  to `opus` and not the coordinator's model. A per-spawn `model` still wins;
- the secret-file deny list;
- `worktree.baseRef: "head"`, so worker worktrees branch from the current
  `HEAD` and not the remote default branch, and a worker sees the
  coordinator's integration branch.

## Project settings (`mimir-cc enable`)

`mimir-cc enable` merges into the project's `.claude/settings.local.json`,
which is per-user, gitignored, and copied into the worktrees the desktop app
creates. It writes the plugin enablement, and the part of the wrapper's
settings a session started without the wrapper would lack: subagent
environment, worktree base ref, secret-file deny list.

`mimir-cc disable` removes exactly those entries and keeps anything you added
or changed since. Both commands also remove an `"outputStyle": "Mimir"` entry
when one is present; the persona comes from the plugin.

For Mimir to stay out of other projects, the plugin must not be enabled in
`~/.claude/settings.json`. `enable` prints a note when it is.

## Worker models

Delegation runs three workers: `impl`, `test` and `review`. Left unset, each
runs on the coordinator's own model.

Pin a model per role under `workerModels` in `~/.mimir/config.json`:

```json
{
  "workerModels": {
    "claudeCode": { "impl": "opus", "test": "opus", "review": "opus" },
    "opencode": { "impl": "anthropic/claude-opus-4-5" }
  }
}
```

| Namespace | Values |
|-----------|--------|
| `claudeCode` | Agent-tool tiers: `sonnet`, `opus`, `haiku`, `fable` |
| `opencode` | `provider/model` ids |

A missing key, namespace or role means that role runs on the coordinator's
model. Nothing prompts for `workerModels`: edit the file by hand. The edit
survives `/mimir-update`, which merges the installer's keys over the existing
config.

`delegate start` reports what it resolved on a `worker models:` line, and
`delegate status` prints the same line.

Pin the roles when the coordinator runs a premium tier: three workers on that
tier use up a subscription's budget fast, on work the coordinator never reads
in full. When the coordinator is already on `opus` or something cheaper,
pinning changes nothing or costs more.

### In `mimir.toml`

The same table can live in `mimir.toml`. The user file (`~/.mimir/mimir.toml`)
is read first, then the project's (`./mimir.toml`), and the result wins over
`config.json` role by role:

```toml
[workers.models.claudeCode]
review = "sonnet"          # only the review role changes; impl and test stay on config.json

[workers.models.opencode]
impl = "ollama/qwen3"
```

A project's `mimir.toml` can be committed, so a repository can pin worker
models for everyone who delegates in it.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `MIMIR_API_KEY` | — | Server API key. The installer reads it from the environment |
| `MIMIR_USER_MEMORY_DB` | `userMemoryDb` in `config.json`, then `~/.mimir/user-memories.db` | Path of the user-memory database |
| `MIMIR_ANCHOR_INTERVAL` | `3` | Turns between voice anchors |
| `MIMIR_EDIT_GUARD` | on | `0` disables the Bash edit guard for a session |
| `MIMIR_EXTRACTION_BASE_URL`, `MIMIR_EXTRACTION_MODEL`, `MIMIR_EXTRACTION_API_KEY` | — | An extraction endpoint to use in place of the session's own model. See [Extraction configuration](../../packages/plugin-core/README.md#extraction-configuration) |
