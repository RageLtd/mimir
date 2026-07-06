/**
 * Org-scope migration (MIM-69, slice 1) — idempotent, runs every boot from
 * initSchema after migrateLegacyProjectKeys.
 *
 * Three jobs, all safe to re-run:
 *
 *   1. **Backfill** `org_id` on every tenant row still missing it, parking it
 *      on the owner org (the real Better Auth org when the instance is
 *      claimed, else OWNER_ORG_SENTINEL for the auth-off homelab).
 *   2. **Sentinel remap** — once an instance that started life on the sentinel
 *      is claimed, move those rows onto the real owner org id.
 *   3. **Project dedupe** — collapse duplicate project records that share a
 *      git_remote onto one canonical record, reassigning history (message_log,
 *      memory) and dropping regenerable index rows (cart_*).
 *
 * Owner resolution reads the auth SQLite store, which at first boot may not
 * have its schema yet (initSchema runs before runAuthMigrations) or may be
 * pre-claim (no owner org). Both are tolerated: resolution returns null and
 * the backfill defers to the next boot after the claim — the migration
 * self-heals. Dedupe is auth-independent and always runs.
 *
 * Follows the db-as-parameter discipline of migrate-project-keys.ts (no import
 * from surreal.ts → no cycle, and the mockable getDb seam stays untouched).
 * SQL generation is factored into pure builders so the string shapes are
 * unit-tested without a live database, matching schema-drift.ts.
 */

import { RecordId, type Surreal } from "surrealdb";
import { getAuthDb } from "../auth/instance";
import { config } from "../config";
import { log } from "../util/logger";
import { attempt, attemptSync } from "../util/result";
import { OWNER_ORG_SENTINEL } from "./scope";

/** Every tenant table gains org_id — the full scoping surface. */
export const ORG_SCOPED_TABLES = [
  "memory",
  "relates_to",
  "message_log",
  "compaction_state",
  "hygiene_state",
  "cart_file",
  "cart_import",
  "cart_git_state",
  "project",
] as const;

/** On a project merge these carry history and are reassigned onto the
 *  canonical id — their rows are the brain and must survive. */
export const REASSIGN_CHILD_TABLES = ["message_log", "memory"] as const;

/** On a project merge these are dropped for the duplicate: the index is a
 *  full DELETE-then-INSERT per sync, so the canonical record's next sync
 *  rebuilds them — and dropping sidesteps the cart_file (project_id,
 *  file_path) UNIQUE index colliding on reassignment. */
export const DELETE_CHILD_TABLES = [
  "cart_file",
  "cart_import",
  "cart_git_state",
] as const;

// ---------------------------------------------------------------------------
// Pure SQL builders (unit-tested)
// ---------------------------------------------------------------------------

/** Park every unscoped row on the owner org. */
export const buildBackfillSql = (table: string) =>
  `UPDATE ${table} SET org_id = $owner WHERE org_id = NONE;`;

/** Move sentinel-parked rows onto the real owner org id post-claim. */
export const buildSentinelRemapSql = (table: string) =>
  `UPDATE ${table} SET org_id = $owner WHERE org_id = $sentinel;`;

/** Reassign a history child from a duplicate project onto the canonical. */
export const buildReassignChildSql = (table: string) =>
  `UPDATE ${table} SET project_id = $canonical WHERE project_id = $dup;`;

/** Drop a regenerable index child belonging to a duplicate project. */
export const buildDeleteChildSql = (table: string) =>
  `DELETE ${table} WHERE project_id = $dup;`;

// ---------------------------------------------------------------------------
// Pure dedupe planning (unit-tested)
// ---------------------------------------------------------------------------

export interface ProjectDedupeRow {
  id: string;
  git_remote: string;
  updated_at: string;
}

export interface MergePlan {
  git_remote: string;
  canonicalId: string;
  dupIds: string[];
}

/**
 * Group project rows by git_remote and, for any remote owned by more than one
 * record, pick the most-recently-updated as canonical and mark the rest as
 * duplicates to fold in. Rows are assumed to all carry a git_remote (the
 * caller filters `git_remote != NONE`); remote-less local-only projects can't
 * be safely equated and are left alone.
 */
export function planProjectMerges(rows: ProjectDedupeRow[]) {
  const byRemote = new Map<string, ProjectDedupeRow[]>();
  for (const row of rows) {
    const group = byRemote.get(row.git_remote) ?? [];
    group.push(row);
    byRemote.set(row.git_remote, group);
  }

  const plans: MergePlan[] = [];
  for (const [git_remote, group] of byRemote) {
    if (group.length < 2) continue;
    // Newest updated_at wins; id is a stable tiebreak so the plan is
    // deterministic across boots (idempotency).
    const sorted = [...group].sort((a, b) => {
      if (a.updated_at !== b.updated_at) {
        return a.updated_at < b.updated_at ? 1 : -1;
      }
      return a.id < b.id ? 1 : -1;
    });
    const [canonical, ...dups] = sorted;
    if (!canonical) continue; // group.length >= 2 guarantees this; narrows for tsc
    plans.push({
      git_remote,
      canonicalId: canonical.id,
      dupIds: dups.map((d) => d.id),
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Orchestration (IO)
// ---------------------------------------------------------------------------

/** First result set of a query, unwrapped (mirrors surreal.ts queryOne). */
async function rows<T>(
  db: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
) {
  const [result] = await db.query<[T[]]>(sql, vars);
  return result ?? [];
}

/** Stringify a record id and strip its table prefix. */
function idString(id: unknown) {
  if (id instanceof RecordId) return String(id.id);
  const s = String(id);
  const colon = s.indexOf(":");
  return colon >= 0 ? s.slice(colon + 1) : s;
}

/**
 * The owner org id to scope legacy data to. `null` means "not resolvable yet"
 * (auth enabled but pre-claim, or the auth schema not migrated) — the caller
 * defers the backfill to a later boot rather than inventing an id.
 */
function resolveOwnerOrgId() {
  if (!config.auth.enabled) {
    return { ownerId: OWNER_ORG_SENTINEL, isSentinel: true as const };
  }

  // getAuthDb() lazily constructs the SQLite store on first call — guarded on
  // config.auth.enabled so an auth-off boot never touches it. At auth-on first
  // boot this runs before runAuthMigrations, so the organization table may not
  // exist yet; the attemptSync below folds that into the null-defer path.
  const [err, ownerId] = attemptSync(() => {
    const authDb = getAuthDb();
    const row = authDb
      .query("SELECT id FROM organization WHERE slug = 'owner' LIMIT 1")
      .get() as { id: string } | null;
    return row?.id ?? null;
  });

  if (err || !ownerId) {
    // Missing table (pre-migration) or no owner org (pre-claim) both land
    // here — defer, don't fabricate.
    return { ownerId: null, isSentinel: false as const };
  }
  return { ownerId, isSentinel: false as const };
}

/** Backfill org_id + (post-claim) remap sentinel rows onto the owner org. */
async function backfillOrgId(
  db: Surreal,
  ownerId: string,
  isSentinel: boolean,
) {
  for (const table of ORG_SCOPED_TABLES) {
    await db.query(buildBackfillSql(table), { owner: ownerId });
  }
  // When the owner is a real org id, sweep any rows a prior auth-off life
  // parked on the sentinel onto it too.
  if (!isSentinel && ownerId !== OWNER_ORG_SENTINEL) {
    for (const table of ORG_SCOPED_TABLES) {
      await db.query(buildSentinelRemapSql(table), {
        owner: ownerId,
        sentinel: OWNER_ORG_SENTINEL,
      });
    }
  }
}

/** Collapse duplicate project records that share a git_remote. */
async function dedupeProjects(db: Surreal) {
  const raw = await rows<{
    id: unknown;
    git_remote: string;
    updated_at: string;
  }>(
    db,
    `SELECT id, git_remote, updated_at FROM project WHERE git_remote != NONE`,
  );
  const plans = planProjectMerges(
    raw.map((r) => ({
      id: idString(r.id),
      git_remote: r.git_remote,
      updated_at: String(r.updated_at),
    })),
  );
  if (plans.length === 0) return 0;

  let merged = 0;
  for (const plan of plans) {
    for (const dup of plan.dupIds) {
      for (const table of REASSIGN_CHILD_TABLES) {
        await db.query(buildReassignChildSql(table), {
          canonical: plan.canonicalId,
          dup,
        });
      }
      for (const table of DELETE_CHILD_TABLES) {
        await db.query(buildDeleteChildSql(table), { dup });
      }
      await db.query(`DELETE $id`, {
        id: new RecordId("project", dup),
      });
      merged++;
      log.info(
        { git_remote: plan.git_remote, canonical: plan.canonicalId, dup },
        "org-scope migration: merged duplicate project record",
      );
    }
  }
  return merged;
}

/**
 * Run the org-scope migration. Call from initSchema after
 * migrateLegacyProjectKeys (project_id must be populated before dedupe
 * reassigns it) and before the project_id index block.
 */
export async function migrateOrgScope(db: Surreal) {
  const start = Date.now();

  const mergedProjects = await dedupeProjects(db);

  const { ownerId, isSentinel } = resolveOwnerOrgId();
  if (!ownerId) {
    log.info(
      "org-scope migration: owner org not resolvable yet (pre-claim) — org_id backfill deferred to a later boot",
    );
    if (mergedProjects > 0) {
      log.info(
        { mergedProjects, elapsed: `${Date.now() - start}ms` },
        "org-scope migration: project dedupe applied",
      );
    }
    return;
  }

  const [backfillErr] = await attempt(() =>
    backfillOrgId(db, ownerId, isSentinel),
  );
  if (backfillErr) {
    // Surface loudly but don't abort boot here — surreal.ts owns the fatal
    // decision. A partial backfill is idempotently completed next boot.
    log.error(
      { err: backfillErr },
      "org-scope migration: org_id backfill failed",
    );
    throw backfillErr;
  }

  log.info(
    {
      owner: ownerId,
      isSentinel,
      mergedProjects,
      elapsed: `${Date.now() - start}ms`,
    },
    "org-scope migration: applied",
  );
}
