# Claude Code hooks reference

What each hook in the Claude Code plugin's hooks module does. It is for
someone debugging a Mimir session under Claude Code, or changing the module.
To install and run the plugin, see the
[cc-plugin README](../../packages/cc-plugin/README.md). For why the plugin is
built this way, see [About the Claude Code plugin](architecture.md).

The module is `packages/cc-plugin/hooks/register.ts`, loaded through the
`modules` entry of `hooks/hooks.json`, with one file per concern. `hooks.json`
names the module and nothing else; the plugin has no command hooks. It
requires Claude Code 2.1.319 or later.

Each hook reaches the brain by running the installed `mimir-cc` binary through
`$.process.run`, with `MIMIR_ACTIVE=1` set for the run so the binary's gates
pass. Each fails open with a status line: a binary that errors costs that hook
its work and never the prompt or the tool call. The hooks' `↻` lines go
through the engine's status line (`$.ui.status`), which each host renders its
own way.

`manifests.spec.ts` pins every subcommand the module runs to the CLI's
dispatch table.

## Prompt hooks

### `prompt.compose` → persona

Answers with the installed `~/.mimir/cc/system-prompt.xml` in place of the
engine's own sections, in every session. Three of the engine's sections are
kept ahead of it, because the persona has no answer for them: `user_privacy`
(keep the developer's details out of requests to outside services),
`session_guidance` (how a typed `/<skill>` is invoked) and
`context_management` (a long conversation is summarised). The engine's leading
"You are Claude Code" line is outside what a module answers and stays; the
persona's environment block says what it means.

Falls back to the canonical Markdown, and to Claude Code's own prompt (with a
status line saying so) when no persona is installed.

### `prompt.attachment` (`output_style_instructions`) → the forced style left out

Once `prompt.compose` has supplied the persona, the plugin's own
`# Output Style: mimir-cc:Mimir` attachment is answered `{ text: null }`. Any
other style, any other attachment, and every attachment before a compose or
after a failed one pass through.

### `prompt.submit` → `mimir-cc boot-context`, `mimir-cc retrieve`, `mimir-cc voice-anchor`

Counts the developer's turns in `$.state`.

- **Boot context.** On the session's first prompt, and on the first prompt
  after a reset (a compaction or `/clear` that replaced or emptied the window,
  seen from the messages or from the compaction's flag), the `<boot_context>`
  block rides the prompt as context: the user profile and the active project
  from the local stores. A boot-context run that fails is not retried until
  the next reset. The block has no prior-session section; retrieval carries
  that.
- **Retrieval.** Every turn: the relevant project memories, summaries and
  playbooks for the prompt, attached as prompt context, with the
  "↻ Retrieved N memories" line on the status bar.
- **Voice anchor.** Every `MIMIR_ANCHOR_INTERVAL` turns (default 3), and on
  the first prompt after a reset, where the cadence restarts:
  `voice-anchor --session <id> --nth <n>` returns the next exchange in the
  session's rotation through the prompt's `<voice_in_action>` library as a
  `<voice_anchor>` block, attached after the retrieval. It refreshes the
  persona in the most recent context, against drift over a long session. The
  rotation starts at a hash of the session id, so short sessions do not all
  open on the same exchange. The binary keeps no state.

### `prompt.submit` → `mimir-cc session-start` and the binary pin

Both run off the prompt, in dispatches of their own. A failure of either is a
status line and costs the prompt nothing.

- **`session-start`** runs on the process's first prompt, and again on the
  first prompt after an in-process resume (seen from `session.end` with reason
  `resume`), with that session's id and cwd. It does not run after a `/clear`.
  It does a silent key reconcile and a blind org sync, both bounded, then
  starts a detached full re-index of the project into the local cartographer
  index.
- **The pin** runs once per process, on its first prompt:
  `scripts/ensure-binary.sh` for the binary released with this plugin's
  version.

Neither hangs off `classic.SessionStart`, which Claude Code passes over for
plugins a person installs where an organization manages it.

## Tool hooks

### `tool.call` → `mimir-cc rules` and `mimir-cc guard`

The one unmatched tool hook, run on every call with the PreToolUse-shaped
payload the two subcommands read. Both legs run at once and fail open on their
own.

**Rules** runs the rule engine against every `.claude/**/*.enforce.toml` file
under the project root. A blocking finding denies the call with the findings
as the reason; a nudge rides the tool's result as context the model reads
after it. The rule format is in the [`.enforce.toml` reference](../rules.md).

**Guard** is the role guard for delegation workers. `tool.call` fires inside
subagents too, carrying the loop's `agentId`; the module fills in the agent's
type from `$.agent.list()` and the binary resolves the worker's worktree from
its id. `mimir-impl`, `mimir-test` and `mimir-review` map to their roles, no
agent is the main session (`coordinator`), and any other subagent is left
alone. The coordinator role stays silent unless the delegation skill has
written an active coordinator state for the session
(`~/.mimir/agents/<session>.json`).

| Role | Denied |
|------|--------|
| `impl` | Writing test files |
| `test` | Writing anything but test files |
| `review` | Writing at all |
| `coordinator` | Writing files, spawning a worker before its plan file exists, reading implementation inside a worker worktree |
| every role | `git push`, `git reset --hard`, `git branch -D`, `git clean -f`, `rm -r` outside the agent's worktree, and any read or write of secret material (`.env*`, keys, `~/.ssh`, `~/.aws`…) |

The same secret paths are also `Read(...)` deny rules in the installed
settings, so Bash `cat` is covered too. The decision is `guardDecision` in
plugin-core; the subcommand only builds the context and speaks the hook
protocol.

### `tool.call` (Bash) → edit guard

Denies a Bash command that edits files, with a reason pointing the model at
the Edit tool. Claude Code's auto permission mode tells the model to prefer
Bash (sed, heredocs, scripts) over Edit and Write, which hides changes from
the chat, bypasses every file rule in the engine, and never shows as a diff.

- **A single explicit file**: `sed -i` on one path, a redirect or heredoc
  into one path, `tee` to one path, an inline `python`/`node`/`perl` snippet
  writing one literal path.
- **Bulk mechanical edits**: several paths, globs, `find`/`xargs`,
  `git ls-files`, loops, `glob`/`os.walk` in a script. The reason points at
  the Edit tool per file, or the project's formatter or codemod for a genuine
  sweep.

Read-only uses, scratch paths under `/tmp`, and anything ambiguous pass
silently: a hook that blocks a legitimate command is the worse failure.

The classifier (`hooks/shell-edit.ts`) runs in the module itself, with no
binary, and the deny holds in every permission mode. Set `MIMIR_EDIT_GUARD=0`
to disable it for a session.

### `tool.call` (Read) → `mimir-cc file-context`

Runs beside the read, never ahead of it. Attaches the file's cartographer info
(symbols, imports, dependents) and related memories from the local index and
replica to the result as context, with the "↻ File context" line on the status
bar. The binary dedupes per session by content hash.

### `tool.call` (Edit, Write) → `mimir-cc reindex`

Once the write has landed, the binary forks a detached cartographer worker
that parses the changed file into the local index, and exits at once. A
subagent's edit, inside its worktree, is skipped.

### `tool.call` (SubagentHandback) → `mimir-cc verify`

The gate on a worker's "done" claim: re-checks the worker's worktree before
the hand-back is accepted. A block denies the call, so the worker keeps
working. A pass rewrites the message with the report appended.

## Session hooks

### `turn.complete` (main loop) → `mimir-cc persist`

The messages since the last distillation, read from
`$.session.messages({ as: "api" })` with media stripped, distilled into the
local replica. Where the last distillation stopped is an anchor in `$.state`
(`hooks/messages.ts`) that the module moves when the binary answers
`{ advance: true }`; it finds its place again after the engine's 4096-row
window slides. A subagent's turns are its own.

### `session.compact` (main loop) → `mimir-cc precompact`

The undistilled tail, summarised and extracted before Claude Code compacts the
context. Afterwards the anchor is the compacted conversation, so the engine's
summary is never distilled as a turn. A `precompute` passes over: it installs
nothing.

### `session.end` → `mimir-cc session-end`

Sends the undistilled tail, media stripped. The binary takes it into the
session journal and summarises the session from it, so the next session picks
up its narrative.

The hook hands off and returns: the engine's `session.end` chain shares one
short wall-clock bound (1.5 s by default), so the binary detaches the
summarising worker and returns at once, and no model call runs in the hook.

It runs for every end reason, a `/clear` included. An empty conversation, or
one precompact already summarised as it stands, runs nothing.

After a `/clear` or a resume the process goes on under another session, so the
hook flags the next prompt as a reset, and for a resume as one that starts
`mimir-cc session-start` again.

## Distillation

Both distillation hooks, `persist` and `precompact`, run on the session's own
model client, so a Claude Code session needs no extraction endpoint.

The module marks its payload `host_completions: true`. With no
`extractionBaseUrl` configured, the binary answers its first run with
`requests`: the extraction prompts (and, for precompact, the summary prompts)
it rendered. The module runs them in parallel through `$.model.complete` on
`haiku` at low effort, then hands the results back as `completions` on a
second run that parses and stores them.

A configured `extractionBaseUrl` and `extractionModel` win: the binary
extracts through that endpoint in one run. See
[Extraction configuration](../../packages/plugin-core/README.md#extraction-configuration).

Neither hook holds the user. It captures the delta, marks it `pending` in
`$.state`, and schedules the run with `$.clock.after(0, …)`, so
`turn.complete` and `session.compact` pass on at once and distillation runs
after them.

One persist is in flight at a time: a turn that ends while one is pending
schedules nothing, and the next turn's delta carries its messages. A pending
older than `PENDING_STALE_MS` (260 s: a worst-case persist plus a minute's
slack) blocks nothing; that is a session that ended mid-run.

A precompact always schedules, and its anchor write lands only if no re-anchor
came first. A pathological precompact can outlive the stale bound and overlap
a persist; its duplicate facts dedupe and both anchor writes are
version-checked.
