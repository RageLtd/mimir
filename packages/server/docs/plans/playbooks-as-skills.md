# Trigger-Indexed Playbooks (skill-parity layer)

**Status:** design (not started)
**Owner:** Rage · Drafted: 2026-06-15
**Lineage:** the concrete design for the deferred *"dedicated `<playbooks>`
injection block with intent/JIT triggers"* item under
[`memory-hygiene.md`](../memory-hygiene.md) → Phase 2 Skill/Playbook layer.
**Depends on:** Phase 2 v1 (`project_playbook_store`, retrieved-as-memory) — shipped.
**Touches:** `packages/server` (core), `packages/acp`, `packages/cc-plugin`.

> **Terminology (settled 2026-06-15).** One concept, one noun: **playbook**.
> There is no user-facing "skill" in our world — "skill" only ever names Claude
> Code's native mechanism we're reaching parity with. Scope is a *field*, not a
> type: a playbook with no `project` is generic/portable; one with a `project`
> UUID is bound to that repo. The reserved `skill` memory type stays unused and
> is a candidate for removal.

## Context

Today a playbook is a memory row with `type: "playbook"` — distinguished from
`type: "fact"` only by living in `PROTECTED_TYPES` (the hygiene forget/consolidate
passes skip it; `skill` is also reserved there). Structurally it is a single
`content` body, an optional project UUID, and an embedding **computed from the
body**. It surfaces exactly like a fact: `retrieveMemories` runs a hybrid
vector+text search against the last ~3 user messages, scores by relevance ×
freshness × confidence (+ a project tiebreaker), and folds the top-K into the
context as a flat `- content` list. `project_playbook_store` rides
`getMcpPublicTools()` → `/mcp`, so CC and Zed already discover it.

Three things make this fall short of a Claude Code Skill:

- **No structure.** A CC skill is *name + "when to use" + body*. A playbook is
  just a body. There's nothing to build a menu from.
- **No discovery.** There's no always-present index of available playbooks —
  one only appears if it happens to be semantically near your prompt.
- **Weak, all-or-nothing loading.** The match key is the **body** (procedure
  steps), which reads nothing like a task description, so ambient retrieval is a
  fuzzy coin-flip; and it's the whole body or nothing.

## Core insight — the trigger is the mechanical hook

CC Skills work by **progressive disclosure**: a cheap always-present index (name
+ description) plus on-demand body load. The piece that makes *automatic* loading
reliable here is the **trigger**. A trigger ("use this when auditing Railway env
vars") is authored precisely to describe *when the playbook applies* — so it
matches a task description far better than the procedure body ever could.

So the trigger does double duty: it's the human-readable "when to use" line in the
index, **and** the embedding key for ambient matching. Embed the trigger (not the
body); match the user's message against playbook triggers; inject the body of any
whose trigger crosses threshold. That turns ambient injection from "fuzzy and
untrustworthy" into "precise and mechanical" — no model judgment required to load
the right one.

## Decisions locked (2026-06-15)

- **`name` + `trigger` are real structured fields**, not parsed from the body.
- **Index is always injected** — every playbook's name + trigger (no bodies) —
  so the menu is constant and cheap. Not gated behind a tool the model must
  remember to call.
- **Ambient body injection stays**, driven by trigger-match (above) — the
  trusted mechanical loader. Deliberate model invocation alone was rejected as
  untrustworthy.
- **`load_playbook` tool** for deliberate fetch by name, registered as a server
  tool **and** a public `/mcp` tool (so CC pulls the same learned procedures).
- **Every playbook is indexed from birth** — no curation/promotion gate; all
  appear in the index immediately. Editing is allowed. (Authoring feels like
  asking Claude Code to write a skill file: name it, say when to use it, write
  the steps — but the stored thing is a playbook.)

## Architecture

### Schema

Add to playbook rows: `name` (short label) and `trigger` ("use when…"). For
`type="playbook"`, the stored embedding is computed from **`trigger`** (optionally
`name + "\n" + trigger`), not from `content`. Facts are unchanged (still embed
`content`).

> **Implementation note:** the exact SurrealDB SCHEMAFULL migration (new columns
> on the memory table, or a sibling table) and the `storeMemory` signature need
> `goldfish/store.ts` inspected at build time — not yet read. `name`/`trigger`
> are optional at the column level so existing rows remain valid (see Migration).

### Retrieval — three surfacing paths, decoupled

1. **Index (always).** A new injection block lists every in-scope playbook's
   `name` + `trigger`, no bodies. Project-scoped first, then global; capped at N
   (paginate/scope if it grows). This is discovery.
2. **Ambient body (trigger-matched).** Match the user message against playbook
   **trigger** embeddings on a **separate retrieval budget from facts** (e.g. top
   1–2 playbooks above a threshold), and inject those bodies. Separate budget so
   playbooks and facts don't crowd each other out of the shared top-K.
3. **Deliberate (`load_playbook`).** Model (or CC) fetches a specific body by
   name/id when it wants one the index named but ambient didn't fire on.

Facts continue to ride the existing `retrieveMemories` top-K untouched.

### Tools

- **`load_playbook({ name | id })`** → returns the full body. In `getServerTools`
  **and** `getMcpPublicTools` (the `/mcp` unification).
- **`project_playbook_store`** gains `name` + `trigger` params (body stays
  `content`); embeds the trigger.
- **Update path** — edit an existing playbook's name/trigger/body (re-embed
  trigger on change). Reuse/extend `project_memory_update` or add a
  playbook-specific update.

### Claude Code parity

CC assembles its own context, so it won't get the server middleware's index +
ambient injection for free. Two touches give parity:

- `/mcp load_playbook` (+ a `list_playbooks` for the index) covers **deliberate**
  fetch inside CC immediately.
- For **ambient** parity, the cc-plugin `retrieve` hook (UserPromptSubmit) runs
  the same trigger-match-and-inject the server middleware does.

## Anticipated file map

| File | Change |
|------|--------|
| `goldfish/store.ts` | `name`/`trigger` columns; playbook embed = trigger; `listPlaybooks`, `getPlaybookByName` |
| `db/surreal.ts` | memory-table schema migration |
| `agent-loop/server-tools/memory.ts` | `project_playbook_store` + `name`/`trigger`; update path |
| `agent-loop/server-tools/playbook.ts` *(new)* | `load_playbook` (+ `list_playbooks`) tool |
| `agent-loop/server-tools/index.ts` | register in `getServerTools` + `getMcpPublicTools` + `SERVER_TOOL_NAMES` |
| `goldfish/memory.ts` | trigger-matched playbook retrieval on a separate budget |
| `middleware/goldfish.ts` (or context-assembly) | inject the index block + ambient playbook bodies |
| `packages/cc-plugin/src/retrieve-hook.ts` | trigger-match-and-inject parity |

## Migration

Existing playbooks have no `trigger` and are body-embedded. They sit out of the
index and the trigger-match path until re-authored or backfilled (give them a
`name`/`trigger`, re-embed). Trivial today — barely any exist. A backfill pass
could ask the hygiene model to generate a `name`/`trigger` from each legacy body.

## Open questions

- **Index size budget.** Hard cap, or project-scope the always-injected list once
  it's large?
- **Ambient + index overlap.** A matched playbook appears in both the index and
  ambiently — harmless reinforcement, or dedupe?

## Deferred (unchanged from memory-hygiene.md)

- Auto-distillation (a hygiene-style pass clustering task memories into playbooks).
- Client-side user-specific playbooks (`~/.mimir/user-memories.db`) — keeps the
  PII-stays-client-side invariant.

## Verification plan

- Unit: trigger-embedding store/retrieve; index builder; `load_playbook`;
  separate-budget retrieval (facts not crowded out).
- `tsc --noEmit` + Biome clean; `bun run test` green.
- Live: author a playbook with a trigger, confirm it appears in the index, that a
  matching prompt injects its body ambiently, and that `load_playbook` fetches it
  from both the server route and CC via `/mcp`.
