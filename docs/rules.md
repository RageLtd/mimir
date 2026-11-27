# `.enforce.toml` reference

The format of a Mimir enforcement rule: a file that Mimir checks against the
agent's tool calls. This page lists every field. For a first rule, see
[Rules in the README](../README.md#rules). What a host does with a finding is
on that host's page.

## Where rules live

Mimir loads every file matching `.claude/**/*.enforce.toml` under the project
root, symlinked files included. Each file holds one rule.

A file inside a nested checkout (a directory under the project root that has
its own `.git`) is skipped.

A file that fails validation is reported as a load error and its rule is not
loaded. When two files declare the same `id`, the first one loaded wins and
the second is reported as a load error.

## Example

```toml
id = "no-console-log"
event = "file"
message = "Don't ship console.log statements: ${match}"

[[conditions]]
field = "new_text"
operator = "regex_match"
pattern = "console\\.log\\("
```

## Fields

| Field | Type | Required | Default | Meaning |
|-------|------|----------|---------|---------|
| `id` | string | yes | — | Identifier, unique across all loaded rules |
| `event` | string | yes | — | Which tool calls the rule applies to. See [Events](#events) |
| `severity` | `"block"` or `"nudge"` | no | `"block"` | `block` denies the tool call with the findings as the reason. `nudge` lets the call run and gives the findings to the model as advice |
| `enabled` | boolean | no | `true` | `false` turns the rule off |
| `message` | string | no | — | The text the model sees. See [Message interpolation](#message-interpolation). Without it, the body file's content is used |
| `body` | string | no | — | Path to a Markdown file with the rule's rationale, relative to the `.enforce.toml` file's directory. Absolute paths and a leading `~/` are accepted. A path that cannot be read is a load error |
| `conditions` | array of tables | one of `conditions` or `detector` | — | The rule fires when every condition matches. See [Conditions](#conditions) |
| `negative_conditions` | array of tables | no | — | Same shape as `conditions`. If any of them matches, the rule does not fire |
| `exclude_globs` | array of strings | no | — | Globs matched against the file path. If any matches, the rule does not fire |
| `detector` | string | one of `conditions` or `detector` | — | A built-in detector, written `builtin:<name>`. See [Built-in detectors](#built-in-detectors) |
| `detector_args` | table | no | — | Arguments for the detector |

A rule must declare `conditions` or `detector`, and not both.

When the `body` file has `paths` frontmatter, those globs limit the rule to
matching files.

## Events

| Value | Applies to |
|-------|------------|
| `bash` | Terminal commands |
| `file` | File edits |
| `stop` | The agent ending its turn |
| `prompt` | A prompt the user submitted |
| `all` | Every event |

## Conditions

Each entry in `conditions` or `negative_conditions` has three keys, all
required:

| Key | Meaning |
|-----|---------|
| `field` | The part of the tool call to test |
| `operator` | `regex_match`, `contains` or `equals` |
| `pattern` | The regular expression, substring or exact value |

A regular expression that does not compile is a load error.

Fields:

| Field | Value |
|-------|-------|
| `file_path`, `path` | The target file of a file edit |
| `new_text`, `new_string`, `content` | The incoming content of a file edit |
| `old_text`, `old_string` | The text an edit replaces |
| `command` | The terminal command |
| any other name | That key of the tool's input, when its value is a string |

A condition on a field the tool call does not carry does not match.

## Message interpolation

| Placeholder | Replaced with |
|-------------|---------------|
| `${match}` | The whole matched text |
| `${1}` to `${9}` | The regular expression's capture groups |
| `${line}` | The 1-indexed line of the match, when it can be computed |

## Built-in detectors

| Detector | `detector_args` | Fires when |
|----------|-----------------|------------|
| `builtin:file-length` | `limit` (number, default `500`) | The file would have more than `limit` lines after the edit |
| `builtin:test-file` | `negate` (boolean, default `false`) | The edited file is a test file. With `negate = true`, when it is not |

```toml
id = "file-length"
event = "file"
detector = "builtin:file-length"
detector_args = { limit = 500 }
body = "file-length.md"
```

An unknown detector name is a load error.

## Rules Mimir ships

Mimir installs six rules of its own. They are prose the agent reads, not
`.enforce.toml` rules: nothing checks a tool call against them.

| File | Rule |
|------|------|
| `calling-code-first.md` | Write the calling code first |
| `data-for-the-loop.md` | Lay data out for the code that processes it |
| `layers-and-dependencies.md` | A layer or a dependency has to pay for itself |
| `no-needless-work.md` | Do no work the problem does not require |
| `operation-over-type.md` | Organise by operation, not by type |
| `reachable-states-only.md` | Handle only the states that can occur |

Install and update write them to `~/.mimir/rules/`, or to `rules/` under
`MIMIR_HOME` when that is set, and overwrite what is there. A file you edit or
delete comes back on the next update.

Every host loads the Markdown files in that directory ahead of the project's
own `.claude/rules/`:

| Host | Where the agent sees them |
|------|---------------------------|
| Claude Code | A section of the system prompt, before the persona |
| OpenCode, Codex CLI | The same block as the project's rules |
| Delegated workers | The worker's own prompt |
