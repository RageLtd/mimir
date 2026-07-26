---
description: Run a memory hygiene sweep over the local memory replica — consolidate near-duplicate memories, demote contradicted facts, prune stale ones
argument-hint: "[--live] [--model <id>]"
allowed-tools: ["Bash"]
---

You are triggering a memory hygiene sweep. It runs **locally** over the org replica on the developer's configured extraction model (MIM-86) — nothing is sent to the server. There is no periodic scheduler, so this command is the deliberate way to run one.

Run the subcommand — it reads every credential itself from `~/.mimir/config.json` / env, so no keys ever appear in this transcript:

```bash
mimir-cc hygiene $ARGUMENTS
```

Rules:

- No arguments → a **dry run**: the sweep reports what it would merge/demote/prune without mutating anything. This is the safe default — prefer it unless the user explicitly asked to apply.
- `--live` arms the sweep. Only pass it when the user explicitly asked for a live/destructive run.
- `--model <id>` overrides the judgment model (default: the configured extraction model). If the command errors that a model is required, ask the user which model to use — do not guess one.
- The sweep can take a few minutes; the command blocks until the report returns. Relay the report summary to the user verbatim.
- If it fails, show the error as-is. Do not retry with different flags on your own.
