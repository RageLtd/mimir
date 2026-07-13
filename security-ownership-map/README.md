# Security ownership map

This directory is generated from the repository's complete non-merge author history using the sensitivity rules in [`../security-ownership-rules.csv`](../security-ownership-rules.csv). It models people-to-file ownership, file co-change communities, sensitive-code bus factor, and stale/orphaned sensitive paths.

## Current result

- 195 commits and 1,475 historical file paths were analyzed.
- One human author owns 100% of every configured sensitive category; the effective security bus factor is **one**.
- The graph contains 16 co-change communities.
- No sensitive path is old enough to meet the 365-day orphan threshold; the repository is younger than that threshold.
- The summary reports 98 bus-factor-one sensitive hotspots. These include historical paths that have since been deleted, because the ownership graph intentionally represents git history; prioritize paths that still exist in the working tree.
- `github-actions[bot]` appears as a release-commit author but owns no configured sensitive category.

The immediate process control is mandatory review for changes under auth, authorization, key management, crypto, sync, introspection/logging, plaintext stores, and release workflows. A second human reviewer with context in those areas is the only way to raise the effective bus factor; a `CODEOWNERS` file naming the same sole owner documents responsibility but does not reduce concentration risk.

## Regenerate

Run from the repository root after installing the `security-ownership-map` Codex skill:

```sh
uv run --with networkx python \
  ~/.mimir/codex/skills/security-ownership-map/scripts/run_ownership_map.py \
  --repo . \
  --out security-ownership-map \
  --sensitive-config security-ownership-rules.csv \
  --emit-commits
```

GraphML is deliberately omitted. The installed skill currently attaches list-valued attributes that NetworkX's GraphML writer rejects; the JSON graph contains the same topology without that serialization failure.

## Artifacts

| File | Purpose |
|---|---|
| `summary.json` | Sensitive ownership findings and generation parameters |
| `people.csv` | People nodes and aggregate touches |
| `files.csv` | File nodes, sensitivity tags, bus factor, and recency |
| `edges.csv` | Person-to-file touch edges |
| `cochange_edges.csv` | File-to-file co-change edges with Jaccard weights |
| `communities.json` | Co-change communities and inferred maintainers |
| `cochange.graph.json` | Node-link graph for visualization/import |
| `commits.jsonl` | Commit records used for temporal ownership queries |

Use the skill's bounded query helper instead of loading the entire graph:

```sh
python ~/.mimir/codex/skills/security-ownership-map/scripts/query_ownership.py \
  --data-dir security-ownership-map summary --section bus_factor_hotspots
```
