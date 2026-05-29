# Project Resolution — Slice 1 (plugin-only)

**Status:** not started
**Depends on:** nothing
**Blocks:** Slice 2

## Context

Today every hook in `mimir-cc-plugin` keys server-side records by `cwd` — an
absolute filesystem path. That makes the data brittle on two axes:

- **Identity is path-shaped.** Same git repo cloned at `~/Projects/foo` and
  `~/code/foo` on a second machine produces two distinct entries on the brain.
  No cross-machine continuity. A renamed checkout orphans existing records.
- **Paths are absolute everywhere.** `cart_file.file_path` stores
  `/Users/rageltd/Projects/mimir-cc-plugin/src/result.ts` rather than
  `src/result.ts`. Cartographer's `cart_import.target_path` is emitted in
  whatever form its resolver picks (probably workspace-relative). When the
  file-context hook queries dependents with an absolute path, the rows it
  needs match on a relative form and we get `dependents: 0` for every file —
  even hot ones like `logger.ts` with many importers.

These are two faces of the same canonicalisation problem: there's no
project anchor everyone agrees on. Identity wants to be a UUID (or anything
machine-independent), and paths want to be relative to a canonical root.
Both require knowing "what's the project root for this cwd."

The server has already shipped a UUID-keyed Project entity
(`packages/server/src/routes/projects.ts`). `POST /v1/projects/resolve` is
get-or-create by `gitRemote` and/or `localPath`, returning
`{ project: { id, title, description, git_remote, local_path, technologies,
purpose } }`. The mimir-acp client already consumes it via
`packages/acp/src/project/{git,resolver,metadata}.ts`.

The cartographer sync route ALREADY accepts an optional `projectId` in its
IndexPayload (`packages/server/src/routes/cartographer.ts:33`) — when
present it overrides `rootPath` as the cart_file / cart_import row key. The
plugin just isn't sending it.

Slice 1 does **both** halves at once because they share the canonical-root
machinery: resolve the project to a UUID, then normalise every file path
to relative-to-projectRoot before storing or querying. Net result:
cartographer index becomes UUID-keyed, file/import paths become relative,
cross-machine code indexing works, AND `dependents` queries start
returning real numbers. Zero server-side changes.

## Architecture

### New module: `src/project/`

Three files mirroring the ACP layout but adapted for the plugin's
short-lived-hook reality:

#### `src/project/git.ts`

Direct port of `packages/acp/src/project/git.ts`. Shells out to
`git config --get remote.origin.url` with `Bun.spawn`, trims trailing
`.git` / `/` / whitespace, returns the canonical remote or null. Never
throws — failures are logged at debug and reported as null so the caller
falls back to local-path-only resolution.

#### `src/project/resolver.ts`

Adapted from `packages/acp/src/project/resolver.ts`. Differences:

- **No `apiKey` field.** The plugin talks to an unauthenticated mimir-server
  (matches the existing fetch pattern in retrieve / persist / file-context).
- **No SessionState integration.** The result is returned bare; caching is
  the cache module's job.

Exposes `resolveProjectForPath(serverUrl, projectPath)` returning a
`ResolvedProject | null`. On any HTTP / parsing failure → null → caller
falls back to path-only.

#### `src/project/cache.ts`

Persistent disk cache at `~/.mimir/project-paths.json` mapping absolute
project path → UUID. Why disk-backed and cross-session:

- Hooks are short-lived processes (no in-memory state between invocations).
- The path → UUID mapping is stable: git remotes don't change, paths
  rarely move. Caching across sessions avoids a per-hook HTTP call.
- Matches the existing state-file pattern (voice-state, persist-state,
  retrieve-state, file-context-state are all disk-backed under `~/.mimir/`).

API:

- `readCache()` returns `Record<string, string>` (`{} ` on miss / parse fail).
- `writeCache(cache)` writes the full map.
- `getCachedProjectId(path)` reads a single entry.
- `setCachedProjectId(path, id)` updates one entry and persists.

#### `src/project/index.ts`

Top-level helper `getOrResolveProjectId(serverUrl, cwd)`:

1. Check cache → return cached UUID on hit.
2. Cache miss → call `resolveProjectForPath` → cache result → return UUID.
3. Resolver failure (network down, etc.) → return null. Caller falls back
   to the existing `cwd`-as-project behaviour. Never throws.

### Path representation

Adopt **relative-to-projectRoot** as the canonical form for every file
path crossing the plugin/server boundary. Project root is the resolved
project's `local_path` (in practice always equal to the hook's `cwd` for
the session).

Normalisation pattern is a single helper:

```ts
// src/project/paths.ts
import { isAbsolute, relative } from "node:path";

export const toProjectRelative = (projectRoot: string, filePath: string) =>
  isAbsolute(filePath) ? relative(projectRoot, filePath) : filePath;
```

Behavior:

- Absolute path inside the project root → relative form (`src/result.ts`).
- Absolute path outside the project root → still uses `relative` (returns
  `../something`). Acceptable; the index just records the file's
  position relative to where the project lives. Edge case for monorepo
  sibling paths or external configs.
- Already-relative path → passes through unchanged. (`git ls-files`
  output is already relative, so `session-start-hook` becomes a no-op
  after this helper.)

The helper is applied at three seams:

1. **`session-start-hook` → `parseFile`.** Currently converts `git ls-files`
   output (relative) to absolute before passing to cartographer. Reverse
   that decision: pass the relative form through. Cartographer parses
   files relative to its `cwd` (which is `projectPath`), so it handles
   relative paths natively. The `file_path` stamped back onto the
   parsed output is then naturally relative.
2. **`reindex-hook` → `parseFile`.** Currently extracts an absolute
   `file_path` from `tool_input.file_path`. Apply `toProjectRelative`
   before passing to cartographer.
3. **`file-context-hook` → `/file-info` query.** Same normalisation on
   the lookup key. The cached dedup map stays keyed by relative path
   too, since that's what the server returns and what we look up next
   time.

### Hook integration

Three hooks need updating in Slice 1:

#### `src/session-start-hook.ts`

In `runWorker`, after `readConfig`:

1. Call `getOrResolveProjectId(config.serverUrl, projectPath)`.
2. Drop the existing `isAbsolute(file) ? file : join(projectPath, file)`
   normalisation — files stay relative as `git ls-files` emits them.
3. Pass `projectId` (which may be `null`) as the argument to
   `syncIndex(config, projectPath, parsed, projectId, "replace")`.

#### `src/reindex-hook.ts`

In `runWorker`, after `readConfig`:

1. Same `getOrResolveProjectId(config.serverUrl, projectPath)` call.
2. Apply `toProjectRelative(projectPath, filePath)` to the file path
   pulled from the hook payload before calling `parseFile`.
3. Pass `projectId` to `syncIndex(...)`.

#### `src/file-context-hook.ts`

In `runFileContextHook`:

1. Same `getOrResolveProjectId(config.serverUrl, cwd)` call.
2. Apply `toProjectRelative(cwd, filePath)` to the lookup key before
   `fetchFileInfo`. The dedup cache key uses the relative form too so
   future Reads of the same file match correctly.
3. Pass `projectId` to the file-info request (still works server-side
   even though Slice 1's server changes don't include file-info — the
   route just ignores unknown fields). When Slice 2 ships the server
   change, the same call works without further plugin edits.

`syncIndex` already accepts `projectId?: string | null` — the server uses
it when truthy, falls back to `rootPath` when null.

### Failure semantics

`getOrResolveProjectId` returns `null` on any failure (resolver down, git
detection fails, cache corrupt). When null, `syncIndex` falls through to
its existing `rootPath`-keyed behaviour. **No hook is allowed to fail
because resolution failed.** This preserves the "hooks always exit 0"
invariant established by the existing hooks.

The cache invalidation policy is intentionally trivial: stale entries
just keep returning the same UUID, which is fine because the UUID is
the canonical identity. If a user genuinely needs to re-resolve (e.g.
they deleted the server-side project and want a fresh one), they can
delete `~/.mimir/project-paths.json` manually.

## Files to add

- `src/project/git.ts`
- `src/project/resolver.ts`
- `src/project/cache.ts`
- `src/project/paths.ts` — `toProjectRelative` helper.
- `src/project/index.ts`
- `src/project/git.test.ts` (covers detectGitRemote on a real temp repo)
- `src/project/cache.test.ts` (round-trips the cache file)
- `src/project/paths.test.ts` (relative/absolute/outside-root cases)
- `src/project/resolver.test.ts` (mocks fetch like
  `transcript-delta.test.ts:shipDelta` tests do)

## Files to modify

- `src/session-start-hook.ts` — add resolver call, drop the
  isAbsolute/join conversion (relative paths now flow through), thread
  `projectId` into `syncIndex`.
- `src/reindex-hook.ts` — add resolver call, normalise the
  `tool_input.file_path` to relative via `toProjectRelative`, thread
  `projectId` into `syncIndex`.
- `src/file-context-hook.ts` — add resolver call, normalise the lookup
  key to relative, dedup cache keys become relative, pass `projectId`
  to the file-info POST.

No server changes. No settings.json change. No new CLI subcommand.

## Existing references to reuse

- `packages/acp/src/project/git.ts` — port verbatim, replace logger import.
- `packages/acp/src/project/resolver.ts` — adapt (drop apiKey, drop
  SessionState integration).
- `src/result.ts` — `attempt()` for the resolver fetch.
- `src/config.ts` — `readConfig()` for the serverUrl.
- `src/logger.ts` — `createLogger("project-resolver")`, etc.
- `~/.mimir/` directory convention from existing state files.

## Verification

End-to-end:

1. `bun run build` then `mimir-cc update`.
2. Delete `~/.mimir/project-paths.json` to start clean.
3. Restart `mimir`. Watch `~/.mimir/logs/mimir-cc.log` for
   `project-resolver: resolved project <uuid>` from SessionStart.
4. Cache file should now exist with one entry for the project path.
5. Query SurrealDB: `cart_file` rows for the new sync should have
   `project = <uuid>` instead of `project = /Users/rageltd/Projects/...`,
   AND `file_path = "src/result.ts"` (relative) instead of the absolute
   form.
6. Read a file that has many importers (`src/logger.ts` is a good
   candidate — it's used by every hook). The file-context-hook should
   now report a **non-zero** `dependents:` count, confirming the
   relative-path query matches cartographer's emitted target_path.
7. Trigger an Edit on a source file. The reindex worker should also
   resolve (cache hit, no HTTP) and the new cart_file row should land
   under the same UUID + relative file_path. No duplicate row under
   the old absolute path appears.
8. Re-run mimir. SessionStart's first hook should report cache hit, no
   `/v1/projects/resolve` HTTP request (visible in mimir-server logs).

Cross-machine smoke:

9. On a second machine (or fake one via a second `~/.mimir/`), point at the
   same mimir-server, clone the same repo to a different absolute path.
   SessionStart on that machine resolves the same UUID via gitRemote
   matching. Cartographer queries from either machine return the same
   index, including matching file paths because both store the same
   relative form.

Unit tests:

- `git.test.ts` — initialise a temp git repo, set a remote, assert the
  trimmed URL is returned. No remote → null. Not a repo → null.
- `cache.test.ts` — round-trip a map, handle missing file, handle corrupt
  JSON (returns `{}`).
- `paths.test.ts` — absolute-inside-root returns relative, absolute-
  outside-root returns `../...` form, already-relative passes through.
- `resolver.test.ts` — mock `globalThis.fetch` like the existing
  `shipDelta` tests, assert correct POST shape and response handling.

## Scope NOT in Slice 1

- Sending `projectId` to `/v1/messages/persist`, `/v1/context/retrieve`,
  or `/v1/context/assemble`. Those endpoints don't accept the field yet
  and need server-side changes — see Slice 2. The file-info path is the
  exception: Slice 1's plugin already sends `projectId`, the server
  silently ignores it until Slice 2 wires the consumer, no extra plugin
  work needed when that ships.
- Auto-collecting project metadata (technologies, description from
  package.json etc.) and PATCHing it back. Worth doing as Slice 1.5 once
  resolve is proven — see Slice 2 doc for the followup.
- Garbage-collecting stale cache entries when paths disappear. Cheap to
  leave — entries are tiny and stale entries do no harm.
- Authentication. Plugin still talks to an open mimir-server.

## Risks

- **Resolver latency on first hook of a fresh session.** One extra HTTP
  call on the first hook only. Cache warms after that. If users complain,
  the resolver returns null on timeout (5s in the acp version, port
  same) and falls back cleanly.
- **Git remote canonicalisation.** ACP's `git.ts` only trims trailing
  `.git` and `/`. SSH vs HTTPS remotes for the same repo will resolve
  to different projects until canonical normalisation lands server-side.
  Not a Slice 1 concern but worth flagging.
- **Cache file corruption from concurrent writes.** Two hooks firing
  concurrently could race on `writeCache`. Low probability (hooks rarely
  overlap), and worst case is one cache entry lost — the next hook
  re-resolves and re-caches. Atomic-write via `Bun.write(tmp)` + rename
  is a follow-up if it ever bites.
- **Transition window for cart_file path representation.** Existing rows
  store absolute paths. The first SessionStart after Slice 1 ships runs
  in `replace` mode and wipes them, replacing with the new relative
  form — clean cutover, no co-existing representations. Until that
  first SessionStart runs, a Read on a file in the old index would
  miss because the hook now queries with relative paths. Mitigation:
  the file-context-hook already handles the "not in index" case
  gracefully (skips injection silently), so the worst case during the
  one-restart window is a few missed file-context injections, no
  errors surfaced to the user.
- **File-context dedup cache.** Existing dedup state files
  (`~/.mimir/file-context-state/<session-id>.json`) hold absolute-path
  keys. They stay valid for their session but are orphaned once new
  sessions start writing relative keys. Cheap to leave — old state
  files are tiny and per-session.
- **Cartographer's actual target_path emission format.** The plan
  assumes cartographer emits `cart_import.target_path` in a relative
  form. If it doesn't (or uses some other normalised representation),
  dependents queries still won't match even with relative file_path
  storage. Verification step 6 catches this — if dependents stays at
  zero after a fresh SessionStart on a known-imported file, the fix
  moves to either the cartographer Rust side or a server-side query
  normalisation step.
