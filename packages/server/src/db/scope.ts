/**
 * Org-scope primitives (MIM-69).
 *
 * The `OrgScope` object is the spine of multi-tenant data access: every store
 * function takes one as its required first argument so the compiler — not a
 * convention — guarantees a caller decided which org's data it touches. Store
 * functions run their queries on `scope.db` and filter `WHERE org_id =
 * $scope_org`, so forgetting to scope a query is a compile error at the call
 * site rather than a silent cross-tenant leak.
 *
 * Two kinds of scope:
 *  - **Request scope** (`buildScope`, in build-scope.ts): a per-request
 *    connection authenticated with a bridge-minted JWT. Once slice 4 lands
 *    row-level PERMISSIONS, this connection can only see its own org's rows —
 *    the DB enforces what the WHERE clause also asks for (defense in depth).
 *  - **RootScope** (`rootScope`): the shared root connection, which bypasses
 *    PERMISSIONS by Surreal design. Used for boot migrations and background
 *    sweeps. `grep rootScope` enumerates every tenant-isolation bypass.
 */

import type { Surreal } from "surrealdb";
import { log } from "../util/logger";

/**
 * The org id that pre-auth / self-hosted data belongs to. Two roles:
 *
 *  - **Auth-off (homelab)**: there is no Better Auth organisation, so every
 *    row is scoped to this stable string and `rootScope` carries it too —
 *    reads and writes line up without a real org ever existing.
 *  - **Auth-on backfill**: rows that predate scoping are first parked here,
 *    then remapped onto the real owner org id once the instance is claimed
 *    (see db/migrate-org-scope.ts). A generated Better Auth org id is a
 *    nanoid and never collides with this literal.
 */
export const OWNER_ORG_SENTINEL = "owner";

/**
 * The tenant boundary threaded through every store call.
 *
 * `orgId` is the value stamped on writes and filtered on reads. `db` is the
 * connection the query runs on — a scoped session for requests, the root
 * connection for background work. `isRoot` marks the PERMISSIONS-bypassing
 * root connection so callers that genuinely need cross-tenant reach are
 * visible.
 */
export interface OrgScope {
  readonly orgId: string;
  readonly db: Surreal;
  readonly isRoot: boolean;
}

/**
 * A resolved request identity — the user and the org their request is scoped
 * to. The identity gate (middleware/identity.ts) produces one from the auth
 * session; build-scope.ts turns it into a scoped connection (slice 4).
 */
export interface ResolvedIdentity {
  readonly userId: string;
  readonly orgId: string;
}

/**
 * Wrap the root connection as a scope. Defaults to the owner-org sentinel
 * (boot migrations, the auth-off homelab, single-org self-host); slice-4
 * per-org background work passes an explicit orgId to sweep one tenant at a
 * time on the same PERMISSIONS-bypassing connection.
 */
export function rootScope(db: Surreal, orgId: string = OWNER_ORG_SENTINEL) {
  return { orgId, db, isRoot: true } satisfies OrgScope;
}

/**
 * Run a query on the scope's connection and return the first result set,
 * unwrapped — the scoped analogue of surreal.ts's queryOne, but bound to the
 * caller's connection instead of the root singleton.
 */
export async function scopedQueryOne<T>(
  scope: OrgScope,
  sql: string,
  vars?: Record<string, unknown>,
) {
  const [result] = await scope.db.query<[T[]]>(sql, vars);
  return result ?? [];
}

/** Scoped analogue of queryFirst — first row or null. */
export async function scopedQueryFirst<T>(
  scope: OrgScope,
  sql: string,
  vars?: Record<string, unknown>,
) {
  const rows = await scopedQueryOne<T>(scope, sql, vars);
  return rows[0] ?? null;
}

/**
 * Close a request-scoped connection (MIM-69 slice 5). Root scopes wrap the
 * shared singleton and must NEVER be closed — only a per-request scoped
 * session (buildScope) owns its connection and closes it when the request or
 * SSE stream ends. Best-effort: a close failure on an already-finished request
 * is benign, so it's debug-logged rather than propagated (mirrors surreal.ts's
 * best-effort close on a failed handshake).
 */
export async function closeScope(scope: OrgScope) {
  if (scope.isRoot) return;
  await scope.db
    .close()
    .catch((err: unknown) =>
      log.debug({ err: String(err) }, "close of scoped SurrealDB connection"),
    );
}
