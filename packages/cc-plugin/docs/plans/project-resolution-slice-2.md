# Project Resolution — Slice 2 (plugin + server)

**Status:** not started
**Depends on:** Slice 1 must be merged and verified.
**Blocks:** nothing.

## Context

Slice 1 wires the plugin into the Project resolver and gets the cartographer
index keyed by UUID. That's the structural win for code indexing, but
everything else the plugin sends to mimir-server still uses `cwd` as the
project key:

- `/v1/messages/persist` stores transcript turns with `project = cwd`.
- `/v1/context/retrieve` accepts `project` as metadata-only (no scoping).
- `/v1/context/assemble` (boot-context path) same as retrieve.
- `/v1/cartographer/file-info` doesn't accept a project field at all —
  it uses the request's `project` argument which the plugin sends as
  `cwd`.

Result: conversations and file-context queries are still path-keyed. A
session on the linux box can't see message history from the Mac. Slice 2
finishes the job — every endpoint accepts and uses `projectId`, with
graceful fallback to the existing `project` string when the field is
absent (preserving back-compat for any client that hasn't been updated).

## Architecture

### Server changes

#### `packages/server/src/routes/cartographer.ts` — `/file-info`

Add optional `projectId?: string` to `FileInfoRequest`. When present, query
`cart_file` and `cart_import` rows keyed by `project = $projectId` instead
of `project = $localPath`. When absent, fall back to the existing
localPath-keyed query. Same back-compat shape Slice 1's sync route already
established.

#### `packages/server/src/routes/messages.ts` — `/persist`

Add optional `projectId?: string` to `PersistRequest`. Pass it through to
`appendTurn` as an additional metadata field. Two questions to decide:

1. **Does `message_log` get a new column for `project_id`?** Cleanest is
   yes — add `project_id: option<string>` to the SurrealDB schema, store
   the UUID alongside the existing `project: string` for back-compat
   during the transition window.
2. **Does retrieval scope by project_id?** Currently `getLastNModelMessages`
   pulls global tail regardless of project. The Slice 2 question is
   whether `/context/retrieve` and `/context/assemble` should scope by
   project_id when one is sent. Decision: **no** — per existing memory
   ("Goldfish memories are intentionally NOT filtered by project —
   cross-project similarity search is by design"), the brain stays
   global. project_id is metadata for display ("which project did this
   conversation happen in") and for future per-project query endpoints,
   not for filtering retrieval.

#### `packages/server/src/routes/context.ts` — `/retrieve` and `/assemble`

Add optional `projectId?: string` to both request shapes. Use it as a
logging field for now (so server logs show "retrieved for project
<uuid>"). No retrieval-time filtering — see decision above.

### Plugin changes

Every hook that talks to mimir-server gains the same pattern from Slice 1:

1. After `readConfig`, call `getOrResolveProjectId(config.serverUrl, cwd)`.
2. Pass `projectId` (which may be `null`) in the request body alongside
   the existing `project: cwd` field.

Hooks to update:

- `src/retrieve-hook.ts` — `fetchRetrieval` adds `projectId` to the POST body.
- `src/persist-hook.ts` — `shipDelta` call gains projectId; transcript-delta's
  `shipDelta` is extended to forward it. Also pass to `reportTokens`.
- `src/precompact-hook.ts` — same as persist via `shipDelta`.
- `src/file-context-hook.ts` — `fetchFileInfo` adds `projectId` to the POST body.
- `src/boot-context.ts` — `fetchSessionContext` adds `projectId`. (This is
  the `/v1/context/assemble` consumer.)

The reindex and session-start hooks are already updated in Slice 1 and
need no further change here.

### Metadata auto-collection (Slice 1.5 / 2 stretch)

ACP ships an additional piece: `packages/acp/src/project/metadata.ts`
reads manifest files (package.json, Cargo.toml, go.mod, pyproject.toml)
and extracts technologies + description, then PATCHes
`/v1/projects/:id` so the project record reflects the live tree.

Worth porting to the plugin as part of Slice 2 or as an interstitial
"Slice 1.5":

1. Port `metadata.ts` from acp.
2. Port `patchProjectMetadata` from acp.
3. Call it once per session in `session-start-hook` after resolve succeeds.

Decision deferred: include in Slice 2 or ship separately. Including keeps
the project record fresh from day one; deferring keeps Slice 2's diff
focused on routing.

## Files to add

- `src/project/metadata.ts` (if including Slice 1.5)
- `src/project/metadata.test.ts`

## Files to modify

### Server

- `packages/server/src/routes/cartographer.ts` — add `projectId` to
  `/file-info`.
- `packages/server/src/routes/messages.ts` — add `projectId` to
  `/persist`; update `appendTurn` plumbing.
- `packages/server/src/routes/context.ts` — add `projectId` to
  `/retrieve` and `/assemble` (logging only).
- `packages/server/src/db/surreal.ts` — add `project_id` field to the
  `message_log` schema. Migration: optional column, no backfill
  required (back-compat preserved by leaving the existing `project`
  field in place).
- `packages/server/src/agent-loop/message-log/persistence.ts` — accept
  `projectId` parameter on `appendTurn`, store on the row.

### Plugin

- `src/retrieve-hook.ts` — resolve + send `projectId`.
- `src/persist-hook.ts` — resolve + send `projectId` (via `shipDelta`
  and `reportTokens`).
- `src/precompact-hook.ts` — resolve + send `projectId` (via `shipDelta`).
- `src/file-context-hook.ts` — resolve + send `projectId`.
- `src/boot-context.ts` — resolve + send `projectId` to `/assemble`.
- `src/transcript-delta.ts` — extend `shipDelta` signature to accept
  optional `projectId`.

## Existing references to reuse

- `src/project/{git, resolver, cache, index}.ts` from Slice 1 — every
  hook just calls `getOrResolveProjectId(...)`.
- Existing route handlers in cartographer / context / messages — extend
  in place, preserve the existing fields as back-compat.
- `packages/acp/src/project/metadata.ts` — port if doing Slice 1.5.

## Verification

End-to-end after server redeploy + plugin update + mimir restart:

1. Watch `/v1/messages/persist` server logs — `projectId` should now
   appear in the log fields.
2. Query SurrealDB: new `message_log` rows should have both `project`
   (path) and `project_id` (UUID) populated.
3. Trigger a Read on an indexed file. Server log for `/file-info` shows
   `projectId` in the request.
4. Old (pre-Slice 2) message_log rows still queryable via path-based
   queries — back-compat.

Cross-machine smoke (assumes Slice 1 verification passed):

5. On the second machine, ask Mimir about something discussed in a
   previous session on the Mac. The retrieve hook fetches memories;
   the assemble endpoint pulls historical messages; both should now
   surface the cross-machine context because they're keyed by UUID.

If Slice 1.5 metadata patching is included:

6. After SessionStart, query `GET /v1/projects/:id` for this project.
   The `technologies` field should be populated from package.json
   (e.g. `["Bun", "TypeScript", "Biome"]`).

## Scope NOT in Slice 2

- Scoping memory / summary retrieval by project_id. Stays global per the
  existing decision memo.
- Authentication / multitenancy. Adds the `owned_by` story but is its
  own large piece of work.
- Garbage-collecting orphaned message_log rows when a project is deleted.
  Future maintenance concern.
- Backfilling the new `project_id` column on existing message_log rows.
  Old rows just keep using the `project` string field; new rows get both;
  the eventual migration to UUID-only happens when the old `project`
  column is decommissioned (separate proposal).

## Risks

- **Schema migration of `message_log`.** Adding an optional column should
  be non-destructive in SurrealDB, but verify on a non-production instance
  first. The `cart_file` / `cart_import` analog (Slice 1) is simpler
  because the rows are routinely wiped by replace-mode syncs; `message_log`
  is append-only and existing rows persist forever.
- **Endpoint surface widening.** Every endpoint that consumes a project
  identifier now has two ways to receive it (`project` string and
  `projectId` UUID). Lint / documentation should be explicit about
  precedence: when both are present, UUID wins. Old clients sending only
  `project` continue working.
- **Resolver cache invalidation across machines.** Each machine has its
  own `~/.mimir/project-paths.json`. If a remote URL canonicalisation
  bug ships server-side and changes how remotes hash, two machines
  could end up with different UUIDs for the same repo. Mitigation: the
  `git remote` normalisation work flagged in Slice 1's risks needs to
  happen before this matters in practice.
