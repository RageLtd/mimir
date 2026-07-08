/**
 * One-time (idempotent) migration: consolidate every table on canonical
 * project_id ULIDs and drop the legacy `project` path-string key.
 *
 * History: pre-Slice-2 writers keyed memory and the cart_* tables on a
 * `project` string holding whatever the client had in hand —
 * usually a cwd path, later a resolved ULID. This migration:
 *
 *   1. Collects the distinct legacy `project` values still lacking a
 *      project_id per table.
 *   2. Resolves each to a canonical id — path-like values (contain "/")
 *      get-or-create a `project` record keyed on local_path; everything
 *      else is already a ULID and passes through.
 *   3. Backfills project_id on the rows, then REMOVEs the legacy field
 *      definition and UNSETs the stored values.
 *
 * SurrealDB semantics this relies on (verified against the REMOVE/UPDATE
 * statement docs): REMOVE FIELD never deletes stored data — rows keep the
 * value and it stays selectable — and `UPDATE ... UNSET field` is the
 * explicit purge, legal even after the definition is gone. On SCHEMAFULL
 * tables, stale undeclared data blocks future UPDATEs until unset, so the
 * purge is not optional.
 *
 * Runs every boot from initSchema; steady-state cost is one LIMIT-1 probe
 * per table. Takes the db handle as a parameter so it imports nothing from
 * surreal.ts (no import cycle).
 */

import { RecordId, type Surreal } from "surrealdb";
import { log } from "../util/logger";

/** Tables that historically carried the legacy `project` string key.
 *  message_log dropped from the list when the table died (MIM-86) — its
 *  legacy rows, if any remain, are orphaned data the table drop removes. */
const LEGACY_KEYED_TABLES = [
  "memory",
  "cart_file",
  "cart_import",
  "cart_git_state",
] as const;

/** Legacy keys are cwd-style paths; canonical ids never contain a slash. */
const isPathKey = (key: string) => key.includes("/");

/** Sentinel the old compaction path stamped on summaries. Not a project —
 *  rows carrying it stay global (project_id remains unset). */
const GLOBAL_SENTINEL = "global";

const deriveTitle = (path: string) =>
  path.split("/").filter(Boolean).pop() ?? "untitled project";

/** First result set of a query, unwrapped (mirrors surreal.ts queryOne). */
async function rows<T>(
  db: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
) {
  const [result] = await db.query<[T[]]>(sql, vars);
  return result ?? [];
}

/**
 * Get-or-create a project record for a legacy path key; returns the id
 * portion (no "project:" prefix). Deliberately narrower than the projects
 * store's resolveProject — backfill only ever sees local paths, never
 * remotes, and pulling the store in here would create an import cycle.
 */
async function projectIdForPath(db: Surreal, path: string) {
  const existing = await rows<{ id: unknown }>(
    db,
    `SELECT id FROM project WHERE local_path = $path LIMIT 1`,
    { path },
  );
  const found = existing[0]?.id;
  if (found) return idString(found);

  const created = await rows<{ id: unknown }>(
    db,
    `CREATE project CONTENT { title: $title, local_path: $path, technologies: [] } RETURN AFTER`,
    { title: deriveTitle(path), path },
  );
  const id = created[0]?.id;
  if (!id) {
    throw new Error(
      `project-key migration: failed to create project record for path "${path}"`,
    );
  }
  log.info(
    { path, id: idString(id) },
    "project-key migration: created project record for legacy path",
  );
  return idString(id);
}

/** Stringify a record id and strip the "project:" table prefix. */
function idString(id: unknown) {
  if (id instanceof RecordId) return String(id.id);
  const s = String(id);
  const colon = s.indexOf(":");
  return colon >= 0 ? s.slice(colon + 1) : s;
}

/**
 * Backfill project_id from the legacy `project` key on one table, then
 * drop the legacy field (definition + stored values). No-op when the
 * table has no legacy data left. Returns the number of distinct legacy
 * keys migrated.
 */
async function migrateTable(
  db: Surreal,
  table: string,
  resolved: Map<string, string>,
) {
  // Cheap steady-state probe — post-migration boots stop here.
  const probe = await rows<{ project: string }>(
    db,
    `SELECT project FROM ${table} WHERE project != NONE LIMIT 1`,
  );
  if (probe.length === 0) return 0;

  const distinct = await rows<{ project: string }>(
    db,
    `SELECT project FROM ${table} WHERE project != NONE AND project_id = NONE GROUP BY project`,
  );

  for (const { project: key } of distinct) {
    // "global" was never a project — leave project_id unset on those rows;
    // the trailing UNSET still purges the legacy field.
    if (key === GLOBAL_SENTINEL) continue;
    let id = resolved.get(key);
    if (!id) {
      id = isPathKey(key) ? await projectIdForPath(db, key) : key;
      resolved.set(key, id);
    }
    await db.query(
      `UPDATE ${table} SET project_id = $id WHERE project = $key AND project_id = NONE`,
      { id, key },
    );
  }

  // Drop the legacy key: definition first, then the stored values. On
  // SCHEMAFULL tables the UNSET must follow the REMOVE — stale undeclared
  // data would otherwise reject every future UPDATE on those rows.
  await db.query(`REMOVE FIELD IF EXISTS project ON TABLE ${table}`);
  await db.query(`UPDATE ${table} UNSET project WHERE project != NONE`);

  return distinct.length;
}

/**
 * Run the full legacy-key migration. Call between the DEFINE block (the
 * project_id fields must exist) and the project_id index definitions (the
 * UNIQUE indexes would collide on rows still carrying project_id = NONE).
 */
export async function migrateLegacyProjectKeys(db: Surreal) {
  const start = Date.now();
  // Shared across tables so one legacy path resolves to one project record.
  const resolved = new Map<string, string>();
  let migrated = 0;

  for (const table of LEGACY_KEYED_TABLES) {
    migrated += await migrateTable(db, table, resolved);
  }

  if (migrated > 0) {
    log.info(
      {
        distinctKeys: migrated,
        projects: resolved.size,
        elapsed: `${Date.now() - start}ms`,
      },
      "project-key migration: legacy project keys consolidated to project_id",
    );
  }
}
