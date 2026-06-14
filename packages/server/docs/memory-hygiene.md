# Memory Hygiene & Skill Generation

Status: **Phase 1 production-validated. Phase 2 contradiction pass
production-validated (2026-06-07). Skill/playbook layer v1 shipped
(`project_playbook_store`, retrieved-as-memory).**
Owner: Rage · Last updated: 2026-06-14

A server-side background loop that keeps the memory store healthy and, later,
distills repeated work into contextual playbooks. The goal: a model that doesn't
just *remember* but *learns the trade* — repeated tasks succeed because the
relevant know-how is surfaced at the right moment.

---

## Vision: two halves

1. **Memory hygiene** (tractable, low-risk) — a periodic sweep that consolidates
   near-duplicate memories and forgets low-value ones, so the store stops growing
   monotonically and retrieval quality doesn't rot. **Phase 1, shipped.**

2. **Skill / playbook generation** (ambitious, higher-risk) — contextual playbook
   injection. Two trigger modes:
   - *Intent-matched at prompt time* — "check my email" pulls the email playbook
     before the model starts.
   - *Just-in-time discovery* — model learns it's a Postgres DB mid-task, pulls
     the Postgres best-practices playbook.
   **Phase 2, deferred.**

---

## Phase 1 — Memory Hygiene (SHIPPED)

In-process scheduler, modelled on the existing compaction lock. Default sweep
every 6h. Three passes behind a global DB lock, ordered consolidation →
contradiction → forgetting (contradiction added in Phase 2). Dry-run by default.

### File map

| File | Role |
|------|------|
| `goldfish/hygiene/state.ts` | `hygiene_state:global` lock — atomic acquire, finish, `clearStaleHygiene` boot recovery |
| `goldfish/hygiene/score.ts` | Pure `scoreMemory` + `selectForPruning` (forgetting) — **TDD** |
| `goldfish/hygiene/cluster.ts` | Pure union-find `groupClusters` (consolidation) — **TDD** |
| `goldfish/hygiene/llm.ts` | `getHygieneModelConfig` + `mergeMemoriesText` — routes to the hygiene model |
| `goldfish/hygiene/consolidate.ts` | `runConsolidation` — cluster → model-merge → apply/report |
| `goldfish/hygiene/forget.ts` | `runForgetting` — confidence decay + score-gated prune |
| `goldfish/hygiene/index.ts` | `runHygieneSweep` orchestrator + `start/stopHygieneScheduler` |
| `goldfish/store-hygiene.ts` | `listAllMemories`, `createCanonicalMemory`, `decayUntouchedConfidence`, `countMemories` |
| `routes/hygiene.ts` | `POST /v1/hygiene/sweep` manual trigger |
| `db/surreal.ts` | `hygiene_state` table schema |
| `config.ts` | `config.hygiene` block |
| `index.ts` | boot wiring (start scheduler / stop on shutdown) |

### How the passes work

**Consolidation.** Fact memories cluster via union-find over `findNeighbors`
edges at distance ≤ `mergeDistance` (0.18 — looser than the 0.05 write-time
dedup, tighter than the 0.3 neighbour edge). Each cluster goes to the hygiene
model, which fuses it into one canonical statement. On a live run the canonical
memory is created (summed access counts, max confidence carried forward),
members deleted, neighbours relinked. Capped at `maxMergesPerSweep`.

**Forgetting.** `score = confidence × freshness × accessSaturation`, where
freshness is an *unfloored* 30-day half-life decay (unlike retrieval's
floored-at-0.1 freshness — the prune pass needs cold memories to keep sinking).
A per-sweep confidence decay (0.9) hits memories untouched for an interval,
folded into in-memory scoring *before* selection so dry-run shows exactly what a
live run would cut. Prune gates: `type === 'fact'` only (summaries and reserved
`playbook`/`skill` types are protected), age ≥ 14d, score < 0.15, capped at 50.

### Config knobs (env)

| Env var | Default | Meaning |
|---------|---------|---------|
| `HYGIENE_ENABLED` | `true` | Run the periodic scheduler |
| `HYGIENE_INTERVAL_MS` | `21600000` (6h) | Sweep interval |
| `HYGIENE_DRY_RUN` | `true` | Compute & report, mutate nothing |
| `HYGIENE_MODEL` | *(none)* | **Required** — sweep refuses to run if unset |
| `HYGIENE_MODEL_BASE_URL` | `ZEN_GO_BASE_URL` | opencode-go by default |
| `HYGIENE_MODEL_API_KEY` | `OPENCODE_API_KEY` | Shared OpenCode credential |
| `HYGIENE_MAX_TOKENS` | `8192` | Completion budget for a merge call |
| `HYGIENE_MERGE_DISTANCE` | `0.18` | Consolidation cluster threshold |
| `HYGIENE_MAX_CLUSTER_SIZE` | `5` | Max members per merge |
| `HYGIENE_MAX_MERGES` | `20` | Merge cap per sweep |
| `HYGIENE_SCORE_FLOOR` | `0.15` | Prune below this score |
| `HYGIENE_MIN_AGE_DAYS` | `14` | Never prune younger memories |
| `HYGIENE_CONFIDENCE_DECAY` | `0.9` | Per-sweep decay for untouched memories |
| `HYGIENE_MAX_PRUNES` | `50` | Prune cap per sweep |

### Running a dry-run sweep

The hygiene model defaults to opencode-go, but the active config points at
**Chutes** (GLM-5.1). The model id is Chutes-namespaced, so the base URL and key
must be overridden together — the id alone won't reach Chutes:

```
HYGIENE_MODEL=zai-org/GLM-5.1-TEE
HYGIENE_MODEL_BASE_URL=https://llm.chutes.ai/v1
HYGIENE_MODEL_API_KEY=<same value as CHUTES_API_KEY>
```

```bash
# Bare curl = dry run (mutates nothing):
curl -X POST http://mimir.conhost.lan/v1/hygiene/sweep
# Arm it (DESTRUCTIVE):
curl -X POST http://mimir.conhost.lan/v1/hygiene/sweep -d '{"dryRun": false}'
```

The report returns every merge proposal (model-written `canonicalText` +
`memberContents`) and every prune (`score`, `ageDays`, `reason`).

### Verification state

- [x] `tsc --noEmit` clean
- [x] Biome clean
- [x] 16/16 server test suites pass (`bun run test:server`)
- [x] Lock, scoring, clustering covered by colocated TDD tests
- [x] **Validated against the real memory store** — first live sweep 130 → 115 (12 merges)
- [x] Thresholds tuned from real data — `HYGIENE_MERGE_DISTANCE` 0.08 → 0.18 (zero false positives at 0.18)
- [x] One armed (`dryRun:false`) sweep observed and audited

---

## Phase 1 — Validation plan (dry-run tuning)

Run dry-run sweeps against the live store and read the JSON. Tune, repeat.

- [ ] First dry-run: confirm `HYGIENE_MODEL` resolves, sweep completes, report returns
- [ ] **Consolidation review** — are the proposed clusters genuinely the same fact?
  - [ ] Too aggressive (distinct facts clustered) → lower `HYGIENE_MERGE_DISTANCE`
  - [ ] Too timid (obvious dupes missed) → raise it
  - [ ] Is the model's `canonicalText` lossless? Any invented detail? Any dropped specifics?
- [ ] **Forgetting review** — would any proposed prune lose something worth keeping?
  - [ ] Score floor too high (useful memories flagged) → lower `HYGIENE_SCORE_FLOOR`
  - [ ] Floor too low (dead weight surviving) → raise it
  - [ ] Half-life / decay feel right for your access cadence?
- [ ] **Caps** — did either pass hit `MAX_MERGES`/`MAX_PRUNES`? If so the store has a backlog; consider a one-off higher cap.
- [ ] Record tuned values below, then run an armed sweep and audit the logs.

### Tuning log

| Date | Knob | From → To | Why |
|------|------|-----------|-----|
| | | | |

---

## Phase 2 — Contradiction Resolution (PRODUCTION-VALIDATED)

A third sweep pass, ordered **consolidation → contradiction → forgetting**,
behind the same global lock / dry-run default / `HYGIENE_MODEL` guard. An LLM
judge classifies each close-in-topic fact pair into **merge / demote / leave**:
near-but-not-identical pairs that are the same thing (or a lossless supersession)
are *fused*, genuine factual conflicts *demote* the wrong side, and everything
else is left alone.

### Where it sits — the band partition

Consolidation merges near-duplicates at distance ≤ `mergeDistance` (0.18).
Contradiction judges pairs in the band **`(mergeDistance, contradictionDistance]`**
(default ceiling 0.30) — strictly *above* what consolidation handles, so a pair
is never both merged and demoted in one sweep. The tightest conflicts (a
correction phrased almost identically to the claim it corrects) fall inside 0.18
and stay consolidation's job — the merge model already handles supersession.
Contradiction is the net for conflicts too far apart to look like "the same fact."
The pass re-reads the store after a live consolidation, so it only ever sees the
post-merge set.

### How the pass works — the three-way verdict

In this band, distance can't tell "same thing / supersession-with-detail" (wants
a lossless *merge*) from "factual conflict" (wants a *demote*) — only the judge
can. So `classifyPair` (same hygiene model) returns
`{ action: "merge" | "demote" | "leave", survivor: 1|2|null, reason }`, and
`routePair` (pure, exhaustive `switch` via `assertNever`) maps it:

- **merge** → fuse via the *same proven path consolidation uses*
  (`mergeMemoriesText` → the now-exported `applyMerge`: create canonical → delete
  members → relink). This is the claim-level-granularity fix — a detailed memory
  whose one sub-claim was superseded is *preserved by fusing*, not blunted by a
  wholesale demote. No new SurrealQL; `applyMerge` doesn't care if its members
  came from a cluster or a pair.
- **demote** → add a `supersedes` edge winner→loser (`relation_type` on the
  existing `relates_to` table — zero schema work), then multiply the loser's
  `confidence` by `demotionFactor` (0.3). Edge-before-demote, each step isolated
  via `attempt()` — a crash mid-pair leaves a harmless stray edge or an
  un-demoted fact, never data loss. Demote never deletes; the lowered confidence
  sinks the loser in retrieval and feeds the prune pass.
- **leave** → untouched (unrelated, both true, or `survivor` null — the
  documented failure mode is demoting the *right* fact, so an undecided survivor
  collapses to leave).

**Tombstoning.** A memory already on the loser end of a `supersedes` edge is
excluded from candidacy entirely — otherwise a later *merge* could fuse it into a
fresh canonical and resurrect the claim a prior sweep demoted (supersession is a
3-way relationship the pairwise judge can't see). Within one sweep a `consumed`
set gives the same disjointness (a merge deletes its members; a demoted loser is
skipped thereafter). Judge calls are capped at `maxChecks` per sweep; overflow is
logged and deferred, not dropped.

### Retrieval is now confidence-aware

`retrieveMemories` previously scored on relevance × freshness and ignored
`confidence` entirely. It now multiplies by confidence
(`scoreRetrievalCandidate`, pure + tested), so a demoted/superseded fact sinks
below an equal-relevance high-confidence one **immediately** — not only after the
prune pass eventually reaps it. Routine untouched-decay also gently downranks
stale facts as a side effect. The project-match bonus stays additive (outside the
multiply) so it can't be scaled away.

### File map (additions)

| File | Role |
|------|------|
| `goldfish/hygiene/contradict-pairs.ts` | Pure pair dedup / band-filter / sort + `routePair` (merge/demote/leave) — **TDD** |
| `goldfish/hygiene/contradict.ts` | `runContradiction` — edge build → classify → merge\|demote\|leave; tombstones superseded losers |
| `goldfish/hygiene/llm.ts` | `classifyPair` + `CLASSIFY_SYSTEM_PROMPT` (defensive JSON parse) |
| `goldfish/hygiene/consolidate.ts` | `applyMerge` exported so the merge verdict reuses the proven fuse path |
| `util/assert.ts` | `assertNever` exhaustiveness guard for the routing `switch` |
| `goldfish/store-hygiene.ts` | `demoteConfidence`, `listSupersedesEdges` |
| `goldfish/store.ts` | `toRecordId` exported for the demote path |
| `goldfish/memory.ts` | `scoreRetrievalCandidate` — folds confidence into retrieval rank |
| `goldfish/hygiene/index.ts` | wires the pass between consolidation and forgetting; `SweepReport.contradiction` |

### Config knobs (env)

| Env var | Default | Meaning |
|---------|---------|---------|
| `HYGIENE_CONTRADICTION_ENABLED` | `true` | Run the contradiction pass |
| `HYGIENE_CONTRADICTION_DISTANCE` | `0.30` | Band ceiling for a candidate pair |
| `HYGIENE_CONTRADICTION_MAX_CHECKS` | `20` | Cap on judge calls per sweep (dry + live) |
| `HYGIENE_CONTRADICTION_DEMOTION_FACTOR` | `0.3` | Loser confidence multiplier |

### Verification state — PRODUCTION-VALIDATED (2026-06-07)

- [x] `tsc --noEmit` clean
- [x] Biome clean
- [x] 18/18 server test suites pass
- [x] Pure pair selection + outcome routing + retrieval scorer TDD'd
- [x] **Validated against the real store** — supervised dry-run → armed run → idempotency dry-run
- [x] Judge prompt tuned from real proposals (see below)
- [x] Armed (`dryRun:false`) sweep observed — demote + `supersedes` edge applied correctly
- [x] Idempotency confirmed — handled pairs excluded next sweep, no re-demotion

**What the supervised runs proved.** First dry-run flagged **6 of 20** pairs — but
distance was *anti-correlated* with correctness (the lone true positive sat at the
*far* edge, 0.237; the clear false positives at the *tight* edge, 0.20). So
`contradictionDistance` is NOT the discriminator — the **judge prompt** is. The
original prompt conflated "later memory supersedes the *status*" with "earlier
memory is *false*"; a dev-memory store is changelog-like, so benign supersession
is everywhere. Sharpening the prompt to demand the test *"would a reader who
believed the loser be factually WRONG given the winner?"* dropped it **6 → 1** on
the same pairs, keeping only the genuine logical conflict.

The armed run applied demotions correctly: `demotedTo = 0.27` = `0.9 × 0.3` (both
losers had decayed once to 0.9, then the 0.3 factor) — confirming
`demoteConfidence`'s `UPDATE … RETURN AFTER` and the `supersedes` `createRelation`
both run live. Consolidation merged 2 (116 → 114), forgetting decayed 73 / pruned
0. A follow-up dry-run confirmed both handled pairs were excluded (edges persisted
+ read back by `listSupersedesEdges`).

**Behaviour to expect.** `capped: true` is persistent — the store has a backlog of
>20 in-band pairs, so each scheduled sweep judges the tightest 20, acts on the
merge/demote verdicts (a handful), and the next sweep sees a fresh set. It drains
the backlog over ~1–2 days, then steady-state finds ~0 new.

### Three-way verdict — the claim-level-granularity fix (validated 2026-06-07)

The original demote-only judge was *blunt*: a detailed memory whose one sub-claim
went stale got downranked wholesale. Validation showed ~all the "contradictions"
in this changelog-like store were actually supersessions-with-detail, not factual
conflicts — so demote-only was the wrong default. The judge was upgraded to
classify **merge / demote / leave**: merge fuses via the proven consolidation
path so detail is *preserved*, demote is reserved for genuine "one side is now
false" conflicts, and the merge path adds no new SurrealQL.

Validated against the real store: a dry-run split **9 merges + 1 demote + leaves**
— every merge a lossless same-subject fusion, the demote a true subsumed-snapshot
supersession. The first armed three-way run applied **10 merges** (1 graceful
model-decline) + **1 demote** (`demotedTo 0.3`) + 1 consolidation merge + 1 prune;
an independent list check confirmed all 10 canonicals present and all 18 merged
members deleted (store 114 → 102). The **tombstone** guard (exclude already-
superseded losers from candidacy) was added after a dry-run caught two prior
demoted losers being pulled into fresh merges — which would have *resurrected* the
claims they superseded and severed their `supersedes` edges; a re-run confirmed
they're now frozen out.

### Known follow-ups (v2)

- **Negative cache.** A pair ruled *not* a contradiction gets no edge, so it is
  re-judged every sweep forever (only true positives are excluded). ~17/20 rule
  false each run → ~17 redundant judge calls/sweep, 4×/day. A judged-pairs ledger
  keyed on a content hash would skip re-judging unchanged non-contradictions.
- **Claim-level granularity — ADDRESSED** by the three-way verdict (merge
  preserves detail instead of a wholesale demote). See above.
- **Consolidation could also resurrect a tombstoned loser.** The tombstone guard
  lives in the *contradiction* pass. Consolidation (≤0.18, Phase 1) blind-merges
  without checking `supersedes` edges, so a superseded loser within 0.18 of
  another memory could in principle be fused back in. Not observed (losers are
  demoted from the 0.18–0.30 band, so they sit >0.18 from their winners) and a
  fix means touching validated Phase 1 code — flagged, not done.
- **Cost lever.** Each sweep ≈ 20 judge calls (~10 min). If cost bites, raise
  `HYGIENE_INTERVAL_MS` or lower `HYGIENE_CONTRADICTION_MAX_CHECKS`.

---

## Phase 2 — Skill / Playbook layer (v1 SHIPPED — decisions locked)

Contextual playbook injection (see Vision). Playbooks are a special memory
`type`; `PROTECTED_TYPES` already reserves `playbook`/`skill` so the forget pass
never reaps them.

**v1 shipped:** the `project_playbook_store` MCP tool persists a generic,
reusable procedure as a `type="playbook"` memory. Storage reuses the shared
`storeTypedMemory` helper in `agent-loop/server-tools/memory.ts` (embed → dedup →
store → link), and the tool rides the existing `getMcpPublicTools()` → `/mcp`
path, so every client (CC plugin, Zed) discovers it dynamically with no extra
wiring. Delivery is retrieved-as-memory: playbooks surface through the
type-agnostic `retrieveMemories` path. Protection is inherited — both hygiene
passes gate on `type === "fact"` and the forget pass shields `PROTECTED_TYPES`.
Auto-distillation, a dedicated `<playbooks>` block, and client-side
user-specific playbooks remain deferred.

**Decisions locked (2026-06-07):**

- **PII fork — resolved: server-side generic only.** Generic playbooks (Postgres
  best-practices, "how to check email with the Gmail MCP") live server-side as
  `type="playbook"` memories. User-specific playbooks ("Rage's inbox filters")
  are deferred to the client user-memory store (`~/.mimir/user-memories.db`) as a
  later increment — keeps the PII-stays-client-side invariant clean.
- **Generation — resolved: model-driven tool first.** A `project_playbook_store`
  MCP tool the model calls when it recognises reusable know-how worth keeping.
  Auto-distillation (a hygiene-style pass clustering task memories into playbooks)
  is deferred — no "repeated task" heuristic needed yet.
- **Delivery — leaning retrieved-as-memory** for v1 (playbooks ride the existing
  `retrieveMemories` path, already type-agnostic). A dedicated `<playbooks>`
  injection block with intent/JIT triggers is a later upgrade. Not yet locked.

- [x] `project_playbook_store` write path (sets `type="playbook"`, server-side, generic)
- [x] Retrieval surfacing — retrieved-as-memory (rides type-agnostic `retrieveMemories`)
- [ ] (later) dedicated `<playbooks>` injection block with intent/JIT triggers
- [ ] (later) auto-distillation generation trigger
- [ ] (later) client-side user-specific playbooks

---

## Sequencing decision: test now vs build Phase 2 first

**Recommendation: validate Phase 1 against the real store first.** Rationale
captured in the session; revisit this section if the decision changes.

- Every threshold (merge distance, score floor, half-life) is a *guess* until
  real data validates it. Building Phase 2 on un-validated foundations compounds
  error.
- The skill layer shares the memory store and depends on the forget pass
  *never* reaping a playbook — that protection is only proven by watching a sweep
  run.
- Validation is cheap (curl + read JSON + tweak a constant). Phase 2 is a large
  new surface with an unresolved PII fork. Cheap validation precedes expensive
  expansion.

---

## Changelog

- **2026-06-07** (later) — Contradiction judge upgraded from demote-only to a
  **three-way verdict** (`merge` / `demote` / `leave`), the claim-level-granularity
  fix: supersession-with-detail pairs now fuse losslessly via the proven
  `applyMerge` path instead of being bluntly demoted. `judgeContradiction` →
  `classifyPair`; new pure `routePair` (exhaustive `switch` + new `assertNever`
  helper). Added **tombstoning** — superseded losers excluded from candidacy —
  after a dry-run caught two demoted losers being pulled into fresh merges
  (resurrection). PRODUCTION-VALIDATED: dry-run 9 merges + 1 demote, armed run
  applied 10 merges + 1 demote + 1 prune (114 → 102), list-check confirmed all
  canonicals present + members deleted. tsc + Biome clean, 18/18 suites.
- **2026-06-07** — Phase 2 contradiction pass shipped (dry-run default). Third
  sweep pass in the band `(mergeDistance, contradictionDistance]`; LLM judge
  picks the surviving truth, loser gets a `supersedes` edge + confidence demotion
  (never deletes), idempotent via existing-edge exclusion. Retrieval ranking now
  folds in `confidence` (`scoreRetrievalCandidate`) so demoted facts sink
  immediately. New env block `HYGIENE_CONTRADICTION_*`. Playbook-layer decisions
  locked (server-side generic only, model-driven tool first). tsc + Biome clean,
  18/18 suites green. **PRODUCTION-VALIDATED same day**: supervised dry-run
  surfaced judge over-flagging (6/20, distance anti-correlated with correctness)
  → sharpened the prompt to a "would a reader believing the loser be WRONG?" test
  (6 → 1); armed run applied demote (0.9 × 0.3 = 0.27) + `supersedes` edge
  correctly, 116 → 114 via 2 merges; follow-up dry-run confirmed idempotency.
  Follow-ups noted: negative cache for re-judged non-contradictions, claim-level
  granularity, cost lever.
- **2026-06-04** — Phase 1 shipped (dry-run default). Lock, two passes,
  env-only model routing to opencode-go, manual `/v1/hygiene/sweep` route. tsc +
  Biome clean, 16/16 suites green. Pending real-store validation. *(Later
  validated in prod: first live sweep 130→115, 12 merges.)*
