import type { Surreal } from "surrealdb";
import { config } from "../config";
import { log } from "../util/logger";

/**
 * Cartographer schema convergence.
 *
 * `initSchema` (db/surreal.ts) can only ADD fields — every statement is
 * `DEFINE ... IF NOT EXISTS`, a no-op once a field exists. So it cannot heal
 * a live table that has drifted EXTRA fields the source no longer declares.
 * A stray required field with no DEFAULT (e.g. `last_parsed_epoch int`)
 * makes every CREATE fail coercion ("Expected `int` but found `NONE`").
 *
 * cart_file / cart_import are SCHEMAFULL and their DEFINE block in initSchema
 * is the single source of truth for their field set, so at boot we drop any
 * live field the schema no longer declares. This converges the live schema
 * instead of chasing drift one field at a time.
 *
 * Keep these lists in lockstep with the cart_file / cart_import DEFINE
 * statements in initSchema. Anything live but absent here is removed at boot.
 */
const CART_DECLARED_FIELDS: Record<string, readonly string[]> = {
  cart_file: [
    "project_id",
    "file_path",
    "language",
    "symbols",
    "searchable",
    "content_hash",
    "indexed_at",
  ],
  cart_import: [
    "project_id",
    "source_path",
    "target_path",
    "specifier",
    "symbols",
    "indexed_at",
  ],
};

/**
 * Fields tolerated on cart rows beyond the declared schema: the record id,
 * plus the legacy `project` key during the project_id transition —
 * migrateLegacyProjectKeys owns `project` and removes it itself after
 * backfilling; purging it here would destroy the keys the migration still
 * needs to read.
 */
const CART_TOLERATED_EXTRAS = ["id", "project"] as const;

/**
 * Pure: given a table's live field names and its declared set, return the
 * idempotent `REMOVE FIELD` statements for every live field the schema no
 * longer declares. Nested field keys (`foo.bar`, `foo[*]`) are left alone so
 * a declared parent's sub-definitions are never orphaned. Exported for tests.
 */
export const buildDriftRemovalSql = (
  table: string,
  liveFields: readonly string[],
  declaredFields: readonly string[],
) => {
  const declared = new Set(declaredFields);
  return liveFields
    .filter((field) => !field.includes(".") && !field.includes("["))
    .filter((field) => !declared.has(field))
    .map((field) => `REMOVE FIELD IF EXISTS ${field} ON TABLE ${table};`);
};

/**
 * Pure: one UPDATE purging orphaned stored values for undeclared fields.
 * All orphans are unset in a single statement so the row's post-image
 * passes SCHEMAFULL validation even when it carries several. Exported for
 * tests.
 */
export const buildOrphanValuePurgeSql = (
  table: string,
  orphanFields: readonly string[],
) => {
  if (orphanFields.length === 0) return null;
  const fields = orphanFields.join(", ");
  const where = orphanFields.map((f) => `${f} != NONE`).join(" OR ");
  return `UPDATE ${table} UNSET ${fields} WHERE ${where};`;
};

/** Read the live top-level field names for a table via INFO FOR TABLE. */
const liveTableFields = async (db: Surreal, table: string) => {
  // INFO FOR TABLE returns a single info object (not a row array), so query
  // directly rather than via queryOne/queryFirst, which assume row arrays.
  const [info] = await db.query<[{ fields: Record<string, string> } | null]>(
    `INFO FOR TABLE ${table}`,
  );
  return info?.fields ? Object.keys(info.fields) : [];
};

/**
 * Union of field names present in a table's stored row data. Sees orphaned
 * VALUES whose definitions are already gone — INFO FOR TABLE only lists
 * definitions and is blind to them. Cart tables stay small (thousands of
 * rows), so the per-boot scan is cheap.
 */
const storedFieldNames = async (db: Surreal, table: string) => {
  const [rows] = await db.query<[string[][]]>(
    `SELECT VALUE object::keys($this) FROM ${table}`,
  );
  return [...new Set((rows ?? []).flat())];
};

/**
 * Converge cart_file / cart_import onto their declared schema: drop drifted
 * field DEFINITIONS (INFO-based) and purge orphaned stored VALUES
 * (row-data-based). Both are needed — REMOVE FIELD never deletes stored
 * data, and on SCHEMAFULL tables a lingering undeclared value rejects every
 * subsequent UPDATE touching the row (this is what stranded
 * last_parsed_epoch values and blocked the project_id backfill). Runs after
 * the DEFINE block and BEFORE migrateLegacyProjectKeys so the migration's
 * UPDATEs see clean rows. Returns the statements executed for logging.
 */
export const removeDriftedCartFields = async (db: Surreal) => {
  const statements: string[] = [];
  for (const [table, declared] of Object.entries(CART_DECLARED_FIELDS)) {
    const tolerated = [...declared, ...CART_TOLERATED_EXTRAS];
    const live = await liveTableFields(db, table);
    statements.push(...buildDriftRemovalSql(table, live, tolerated));

    const stored = await storedFieldNames(db, table);
    const orphans = stored.filter(
      (f) => !tolerated.includes(f) && !f.includes(".") && !f.includes("["),
    );
    // Remove any lingering definitions for the orphans too (no-op if absent),
    // then purge the values.
    statements.push(
      ...orphans.map((f) => `REMOVE FIELD IF EXISTS ${f} ON TABLE ${table};`),
    );
    const purge = buildOrphanValuePurgeSql(table, orphans);
    if (purge) statements.push(purge);
  }
  const deduped = [...new Set(statements)];
  if (deduped.length > 0) {
    await db.query(deduped.join("\n"));
  }
  return deduped;
};

/**
 * Pure: extract the DIMENSION value from an HNSW index definition string
 * (as returned by INFO FOR TABLE). Null when absent. Exported for tests.
 */
export const parseIndexDimension = (definition: string) => {
  const match = definition.match(/DIMENSION (\d+)/);
  return match?.[1] ? parseInt(match[1], 10) : null;
};

/**
 * Guard the HNSW index dimension against config.embedding.dimensions.
 * `DEFINE ... IF NOT EXISTS` never updates an existing index, so a config
 * change (new embedder) silently mismatches otherwise — vector search then
 * fails or degrades with no obvious cause.
 *
 * Empty memory table → redefine automatically (nothing to lose; this is
 * the blank-instance / fresh-deploy path). Populated table → LOUD error
 * and leave the index alone: the operator must re-embed the corpus
 * (scripts/reembed-import.ts) before the new dimension is usable.
 */
export const ensureEmbeddingIndexDimension = async (db: Surreal) => {
  const [info] = await db.query<[{ indexes: Record<string, string> } | null]>(
    `INFO FOR TABLE memory`,
  );
  const definition = info?.indexes?.memory_vec;
  if (!definition) return;

  const live = parseIndexDimension(definition);
  const wanted = config.embedding.dimensions;
  if (live === null || live === wanted) return;

  const [countRow] = await db.query<[Array<{ count: number }>]>(
    `SELECT count() AS count FROM memory WHERE embedding != NONE GROUP ALL`,
  );
  const embedded = countRow?.[0]?.count ?? 0;

  if (embedded > 0) {
    log.error(
      { live, wanted, embedded },
      "HNSW dimension mismatch on a populated memory table — re-embed the corpus (scripts/reembed-import.ts) before changing EMBED_DIMENSIONS; index left unchanged",
    );
    return;
  }

  await db.query(`
    REMOVE INDEX IF EXISTS memory_vec ON TABLE memory;
    DEFINE INDEX memory_vec ON memory FIELDS embedding
      HNSW DIMENSION ${wanted} DIST COSINE;
  `);
  log.warn(
    { from: live, to: wanted },
    "redefined memory_vec HNSW index for new embedding dimensions (table was empty)",
  );
};
