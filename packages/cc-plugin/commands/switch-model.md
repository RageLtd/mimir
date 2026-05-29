---
description: Switch the model backing this session — pick a non-Anthropic model routed through mimir-server, or return to subscription Anthropic
argument-hint: "[model-id]"
allowed-tools: ["Bash", "AskUserQuestion", "Write", "Read", "mcp__mimir__project_memory_store"]
---

You are switching the model backing for this Claude Code session. The mechanism is the wrapper-managed marker file at `~/.mimir/next-session.json`: you write the marker, tell the user to exit, and the wrapper script picks the marker up on claude's exit and re-launches under the requested model.

The next session starts FRESH — no `--continue`. Anthropic's extended-thinking signatures don't survive cross-backend mutation of the local transcript, so we don't replay it. Continuity bridges via Goldfish instead: you write a comprehensive session checkpoint to project memory before staging the marker, and the incoming session's start-up hook retrieves it as boot context.

Do not skip steps. Do not invent alternative mechanisms.

## Step 1 — resolve the mimir-server URL

Read `~/.mimir/config.json` and extract the `serverUrl` field. Bind it to `<serverUrl>` for later steps. If the file is missing or unparseable, stop and tell the user `Mimir is not installed — run /mimir-install first.`

## Step 2 — present the ranked model list and resolve the target

If `$ARGUMENTS` is non-empty, treat it as the explicit model ID. Trim whitespace, bind to `<model>`, skip to Step 3.

Otherwise: fetch the registry, rank against eval tiers, render the table, then ask.

### Step 2a — fetch the registry

Capture the JSON to disk first, then jq it (do **not** pipe curl directly into jq — `.claude/rules/safety/no-pipe-swallowing.md`):

```bash
curl -s "<serverUrl>/v1/models" > /tmp/mimir-models.json
jq -r '.data[] | "\(.id)\t\(.display_name // .id)\t\(.provider_name // .owned_by // "unknown")"' /tmp/mimir-models.json
```

### Step 2b — bucket each model into an eval tier

`FINDINGS.md` in this repo documents a single-turn persona / rule-adherence eval across 23 models. Use the mapping below to assign every fetched model a tier. Match case-insensitively against either `id` or `display_name`. For substring matches, prefer the most specific rule (e.g. `mistral-medium-3.5` is Tier 2, plain `mistral-medium` is Tier 5 — match specifics first). If a model matches no rule, tier is `?` (untested).

**Tier 1 — Trusted as Mimir**
- `opus-4-7`, `opus-4.7`, `claude-opus-4`
- `glm-5.1`, `glm-5-1`

**Tier 2 — Strong with caveats**
- `gemini-pro` (only if NOT also matching `flash`)
- `mistral-medium-3.5`, `mistral-medium-3-5`
- `sonnet-4.6`, `sonnet-4-6`, `claude-sonnet-4-6`

**Tier 3 — Capable but limited**
- `deepseek-v4-pro`
- `mimo-v2.5`, `mimo`
- `qwen-3.6-27b`, `qwen3.6-27b`
- `gemma-4-31b`, `gemma4-31b`
- `mistral-small-4`

**Tier 4 — Significant problems**
- `qwen-3.5-397b`, `qwen3.5-397b`
- `kimi-k2.6`, `kimi-k2-6`
- `kimi-k2.5`, `kimi-k2-5`
- `qwen-3.6-plus`
- `minimax-m2.7`, `minimax-m2-7`

**Tier 5 — Disqualified**
- `deepseek-v4-flash`
- `nemotron`
- `gemini-3.5-flash`
- `grok-build`
- `codestral`
- `mistral-nemo`, exact `nemo`
- `mistral-medium` (without `3.5` / `3-5` — those are Tier 2)
- `mistral-large`
- `devstral`

### Step 2c — render the ranked table

Print a markdown table sorted by tier ascending, then alphabetically by display_name within tier. Untested models go after Tier 5 at the bottom.

```
| Tier | Model ID                  | Display Name        | Provider     |
|------|---------------------------|---------------------|--------------|
| 1    | claude-opus-4-7           | Claude Opus 4.7     | Anthropic    |
| 1    | opencode-go/glm-5.1       | GLM 5.1             | OpenCode Go  |
| 2    | …                         | …                   | …            |
| ?    | some/new-model-id         | New Model           | Provider     |
```

Above the table, print a one-line preamble: `Eval tiers from FINDINGS.md — Tier 1 trusted as Mimir, Tier 5 disqualified, ? untested.`

### Step 2d — ask the user

Call `AskUserQuestion`:

- question: `Which model should back the next session? Pick a quick option or type an ID from the table via "Other".`
- header: `Model`
- options (2–4 curated picks; "Other" is supplied automatically for free-form ID entry):
  - label: `Claude Opus 4.7 (subscription)`, description: `Tier 1 — the baseline. Returns to subscription Anthropic.`
  - label: `GLM 5.1 (mimir-server)`, description: `Tier 1 — practical front-runner for non-Anthropic routing.`

If the user picks `Claude Opus 4.7 (subscription)`, bind `<model>` to `claude-opus-4-7`.
If the user picks `GLM 5.1 (mimir-server)`, bind `<model>` to `opencode-go/glm-5.1` (or whichever provider variant of GLM 5.1 appeared in the table — prefer `opencode-go` if present, otherwise the first GLM 5.1 row).
If the user picks `Other` and supplies a string, bind `<model>` to that string after trimming.

## Step 3 — determine env overrides

If `<model>` starts with `claude` or `anthropic`, this is the subscription path. Set `<env>` to an empty JSON object: `{}`.

Otherwise this is a mimir-server-routed model. Set `<env>` to:

```json
{ "ANTHROPIC_BASE_URL": "<serverUrl>" }
```

## Step 4 — checkpoint the session to Goldfish

Before staging the marker, write a comprehensive session-state checkpoint to project memory so the next session can pick up the thread. Call `mcp__mimir__project_memory_store` with content that opens with the literal prefix `Session checkpoint (model switch <fromModel> → <model>):` followed by prose covering:

- The investigation or task currently in flight — what we set out to do and where we got to.
- Decisions made and reasoning behind them (especially anything we'd lose if forgotten).
- Files touched or about to be touched, with paths.
- Open questions or unresolved blockers.
- Immediate next step the incoming session should take.

For `<fromModel>`, use whatever model is currently backing this session — read `$MODEL` env if set, otherwise describe as "current session" without a specific ID. Keep the checkpoint dense but readable — this is the only context the incoming session gets, so under-detailing here means losing thread continuity. Over-detailing is fine; the next session can ignore what's not relevant.

This step is mandatory. Do not stage the marker without writing the checkpoint first.

## Step 5 — write the marker

Use the `Bash` tool to land the marker so the `~` expansion is reliable. Substitute the literal `<model>` and `<env>` values you resolved in Steps 2–3 into the JSON body before running:

```bash
cat > ~/.mimir/next-session.json <<'MARKER'
{
  "model": "<model>",
  "env": <env>,
  "flags": []
}
MARKER
```

The single-quoted heredoc (`<<'MARKER'`) prevents accidental shell expansion of any `$` characters that might appear in `<model>` or `<env>`. The flags array is intentionally empty — `--continue` is NOT used. The next session starts fresh and pulls continuity from the Goldfish checkpoint written in Step 4 via the existing session-start retrieval hook.

## Step 6 — instruct the user to exit

Tell the user (verbatim — do not paraphrase the hazard warning):

> Next-session config staged for **<model>**. Session checkpoint written to Goldfish.
>
> Type `/exit` (or press Ctrl-D) to end this session. The wrapper will detect the marker and re-launch Claude Code under the new model. The new session boots fresh and picks up the thread from the Goldfish checkpoint via the session-start retrieval hook.
>
> ---
>
> ⚠️ **Future-session hazard, read this:** This project's local Claude Code transcript at `~/.claude/projects/<encoded-cwd>/*.jsonl` is now **permanently incompatible with `--continue` against any Anthropic model.** From here on, do **not** run `mimir --continue`, `mimir -c`, `mimir continue`, or `mimir --resume <id>` in this cwd against an Anthropic-backed model — Anthropic will reject the request with `400 Invalid signature in thinking block`, because non-Anthropic turns are now interleaved between Anthropic-signed thinking blocks and the signatures no longer validate. Continuity comes from Goldfish; launch fresh sessions and the start-up hook will retrieve recent checkpoints + summaries for you. The wrapper does not detect this and will not stop you. See `mimir-cc-model-routing.md` § "User Hazard" for full context and recovery options.

Do not try to exit the session for them — there is no tool that can. The wrapper handles the rest once they exit.
