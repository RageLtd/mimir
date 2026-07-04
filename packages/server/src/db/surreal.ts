import { Surreal } from "surrealdb";
import { config } from "../config";
import { log } from "../util/logger";
import { attempt } from "../util/result";
import { migrateLegacyProjectKeys } from "./migrate-project-keys";

let db: Surreal | null = null;

async function connect(): Promise<Surreal> {
  log.info(
    {
      url: config.surreal.url,
      ns: config.surreal.namespace,
      db: config.surreal.database,
    },
    "connecting to SurrealDB",
  );

  const instance = new Surreal();
  await instance.connect(config.surreal.url);
  await instance.signin({
    username: config.surreal.user,
    password: config.surreal.pass,
  });
  await instance.use({
    namespace: config.surreal.namespace,
    database: config.surreal.database,
  });

  log.info("SurrealDB connection established");
  return instance;
}

async function isAlive(instance: Surreal): Promise<boolean> {
  const [err] = await attempt(() => instance.query("RETURN true"));
  if (err) {
    log.warn({ err: err.message }, "SurrealDB connection stale");
    return false;
  }
  return true;
}

async function _getDb(): Promise<Surreal> {
  if (db && (await isAlive(db))) return db;

  db = await connect();
  return db;
}

/** Get the database connection (mockable for tests) */
export const getDb = _getDb;

/** Close the DB connection cleanly (for graceful shutdown) */
export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

/**
 * Run a single query and return the first result set (unwrapped).
 *
 * SurrealDB's db.query() returns Array<ResultSet> because a single call can
 * contain multiple statements. This helper peels one layer, so you get the
 * rows array directly instead of [[rows]].
 *
 * Use this when you expect multiple rows from a single statement.
 */
export async function queryOne<T>(
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T[]> {
  const db = await getDb();
  const [result] = await db.query<[T[]]>(sql, vars);
  return result ?? [];
}

/**
 * Run a single query and return the first row (or null).
 *
 * Convenience wrapper around queryOne for the common case where you only
 * need a single record — SELECT ... LIMIT 1, UPDATE ... RETURN AFTER, etc.
 *
 * Returns null if no rows found.
 */
export async function queryFirst<T>(
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T | null> {
  const rows = await queryOne<T>(sql, vars);
  return rows[0] ?? null;
}

/**
 * Cartographer schema convergence.
 *
 * `initSchema` can only ADD fields — every statement is `DEFINE ... IF NOT
 * EXISTS`, a no-op once a field exists. So it cannot heal a live table that
 * has drifted EXTRA fields the source no longer declares. A stray required
 * field with no DEFAULT (e.g. `last_parsed_epoch int`) makes every CREATE
 * fail coercion ("Expected `int` but found `NONE`").
 *
 * cart_file / cart_import are SCHEMAFULL and their DEFINE block in initSchema
 * is the single source of truth for their field set, so at boot we drop any
 * live field the schema no longer declares. This converges the live schema
 * instead of chasing drift one field at a time.
 *
 * Keep these lists in lockstep with the cart_file / cart_import DEFINE
 * statements below. Anything live but absent here is removed at boot.
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
const removeDriftedCartFields = async (db: Surreal) => {
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
const ensureEmbeddingIndexDimension = async (db: Surreal) => {
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

/** Run once at startup to ensure schema exists */
export async function initSchema() {
  const start = Date.now();
  const db = await getDb();

  await db.query(/* surql */ `
    -- Analyzer for full-text search
    DEFINE ANALYZER IF NOT EXISTS memory_analyzer
      TOKENIZERS blank, class
      FILTERS lowercase, snowball(english);

    -- Goldfish memories
    DEFINE TABLE IF NOT EXISTS memory SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS content ON memory TYPE string;
    -- Canonical project ULID (id portion of the project table record).
    -- Optional: user-level memories are not tied to a project.
    DEFINE FIELD IF NOT EXISTS project_id ON memory TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON memory TYPE datetime DEFAULT time::now();
    DEFINE FIELD IF NOT EXISTS last_accessed ON memory TYPE datetime DEFAULT time::now();
    DEFINE FIELD IF NOT EXISTS confidence ON memory TYPE float DEFAULT 1.0;
    DEFINE FIELD IF NOT EXISTS access_count ON memory TYPE int DEFAULT 0;
    DEFINE FIELD IF NOT EXISTS embedding ON memory TYPE array<float>;
    DEFINE INDEX IF NOT EXISTS memory_ft ON memory FIELDS content
      FULLTEXT ANALYZER memory_analyzer BM25;
    DEFINE INDEX IF NOT EXISTS memory_vec ON memory FIELDS embedding
      HNSW DIMENSION ${config.embedding.dimensions} DIST COSINE;

    -- Backfill existing memories missing new fields
    UPDATE memory SET
      last_accessed = last_accessed ?? created_at ?? time::now(),
      confidence = confidence ?? 1.0,
      access_count = access_count ?? 0,
      type = type ?? "fact";

    -- Memory type field (fact vs summary)
    DEFINE FIELD IF NOT EXISTS type ON memory TYPE string DEFAULT "fact";
    DEFINE FIELD IF NOT EXISTS message_count ON memory TYPE option<int>;
    DEFINE FIELD IF NOT EXISTS last_message_id ON memory TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS token_count ON memory TYPE option<int>;
    DEFINE INDEX IF NOT EXISTS memory_type ON memory FIELDS type;

    -- Playbook structure (skill-parity layer). Optional so existing rows
    -- stay valid; populated only on type="playbook" memories. The stored
    -- embedding for a playbook is computed from name+trigger (the "when to
    -- use" line), NOT the body — the trigger matches a task description far
    -- better than procedure steps, making ambient injection mechanical.
    DEFINE FIELD IF NOT EXISTS name ON memory TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS trigger ON memory TYPE option<string>;

    -- Memory relationships
    DEFINE TABLE IF NOT EXISTS relates_to SCHEMAFULL TYPE RELATION FROM memory TO memory;
    DEFINE FIELD IF NOT EXISTS weight ON relates_to TYPE float;
    DEFINE FIELD IF NOT EXISTS relation_type ON relates_to TYPE string;

    -- Message log (Phase 6: Single Brain Architecture)
    -- Global append-only log keyed by [project_id, timestamp]
    -- Enables efficient time-range queries for context assembly
    --
    -- project_id is the canonical project ULID from /v1/projects/resolve.
    -- The legacy cwd-style \`project\` path string was consolidated into it
    -- by migrateLegacyProjectKeys (see db/migrate-project-keys.ts). Typed
    -- option<string> because pre-migration rows are backfilled in place,
    -- but every writer is required to supply it.
    DEFINE TABLE IF NOT EXISTS message_log SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS project_id ON message_log TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS role ON message_log TYPE string;
    DEFINE FIELD IF NOT EXISTS content ON message_log TYPE string | array;
    DEFINE FIELD IF NOT EXISTS tool_call_id ON message_log TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS tool_calls ON message_log TYPE option<array>;
    DEFINE FIELD IF NOT EXISTS name ON message_log TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON message_log TYPE datetime DEFAULT time::now();

    -- Compaction state (Phase 6)
    -- Single global state for the global message log
    DEFINE TABLE IF NOT EXISTS compaction_state SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS tokens_since_last ON compaction_state TYPE int DEFAULT 0;
    DEFINE FIELD IF NOT EXISTS is_compacting ON compaction_state TYPE bool DEFAULT false;
    DEFINE FIELD IF NOT EXISTS last_compaction ON compaction_state TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS updated_at ON compaction_state TYPE datetime DEFAULT time::now();

    -- Memory hygiene state — single global lock for the periodic sweep.
    -- Mirrors compaction_state: atomic acquire via UPDATE ... WHERE is_running
    -- = false, stale-clear on boot to recover from a crash mid-sweep.
    DEFINE TABLE IF NOT EXISTS hygiene_state SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS is_running ON hygiene_state TYPE bool DEFAULT false;
    DEFINE FIELD IF NOT EXISTS last_run ON hygiene_state TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS updated_at ON hygiene_state TYPE datetime DEFAULT time::now();

    -- Cartographer tables. project_id is the canonical project ULID —
    -- indexes over it are defined AFTER migrateLegacyProjectKeys runs
    -- (below), because the UNIQUE indexes would collide on legacy rows
    -- that still carry project_id = NONE at DEFINE time.
    DEFINE TABLE IF NOT EXISTS cart_file SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project_id ON cart_file TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS file_path ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS language ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS symbols ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS searchable ON cart_file TYPE string;
    -- SHA-256 hex of the file contents at sync time. Clients compute and
    -- send this so the server can detect stale-index conditions without
    -- needing filesystem access to the source tree.
    DEFINE FIELD IF NOT EXISTS content_hash ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_file TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_file_path ON cart_file FIELDS file_path;
    DEFINE INDEX IF NOT EXISTS cart_file_searchable ON cart_file FIELDS searchable
      FULLTEXT ANALYZER memory_analyzer BM25;

    DEFINE TABLE IF NOT EXISTS cart_import SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project_id ON cart_import TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS source_path ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS target_path ON cart_import TYPE string;
    -- Raw import specifier string as it appears in source ("./util",
    -- "react", "../config"). Distinct from target_path, which is the
    -- resolved absolute path. Authored-side identity matters for
    -- detecting refactors and for the (project_id, source, target,
    -- specifier) UNIQUE edge.
    DEFINE FIELD IF NOT EXISTS specifier ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS symbols ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_import TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_import_source ON cart_import FIELDS source_path;
    DEFINE INDEX IF NOT EXISTS cart_import_target ON cart_import FIELDS target_path;

    DEFINE TABLE IF NOT EXISTS cart_git_state SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project_id ON cart_git_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS git_head ON cart_git_state TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_git_state TYPE datetime DEFAULT time::now();

    -- Projects (UUID-keyed; identity anchored to git_remote when available,
    -- falling back to local_path). Other tables reference the record id
    -- portion (after "project:") as their 'project' field.
    DEFINE TABLE IF NOT EXISTS project SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS title ON project TYPE string;
    DEFINE FIELD IF NOT EXISTS description ON project TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS git_remote ON project TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS local_path ON project TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS technologies ON project TYPE array<string> DEFAULT [];
    DEFINE FIELD IF NOT EXISTS purpose ON project TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON project TYPE datetime DEFAULT time::now();
    DEFINE FIELD IF NOT EXISTS updated_at ON project TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS project_git_remote ON project FIELDS git_remote UNIQUE;
    DEFINE INDEX IF NOT EXISTS project_local_path ON project FIELDS local_path;
  `);

  // Guard the vector index against embedder/dimension config changes.
  await ensureEmbeddingIndexDimension(db);

  // Converge drifted cart schemas BEFORE the migration — its UPDATEs fail
  // SCHEMAFULL validation on rows still carrying orphaned undeclared values.
  const pruned = await removeDriftedCartFields(db);
  if (pruned.length > 0) {
    log.warn(
      { pruned },
      "converged cartographer schema — removed drifted fields",
    );
  }

  // Consolidate legacy path-string keys onto project_id BEFORE the
  // project_id indexes exist — the UNIQUE indexes below are built over
  // existing rows at DEFINE time and would collide while legacy rows
  // still carry project_id = NONE.
  await migrateLegacyProjectKeys(db);

  await db.query(/* surql */ `
    -- Legacy project-string indexes, superseded by the project_id set.
    REMOVE INDEX IF EXISTS cart_file_project ON TABLE cart_file;
    REMOVE INDEX IF EXISTS cart_file_unique ON TABLE cart_file;
    REMOVE INDEX IF EXISTS cart_import_project ON TABLE cart_import;
    REMOVE INDEX IF EXISTS cart_import_edge ON TABLE cart_import;
    REMOVE INDEX IF EXISTS cart_git_state_project ON TABLE cart_git_state;

    DEFINE INDEX IF NOT EXISTS cart_file_project_id ON cart_file FIELDS project_id;
    -- Sync uses a full DELETE-then-INSERT per project, so one row per
    -- (project_id, file_path) pair is the invariant. The UNIQUE index
    -- makes it a hard constraint rather than a convention waiting to fail.
    DEFINE INDEX IF NOT EXISTS cart_file_project_id_unique ON cart_file
      FIELDS project_id, file_path UNIQUE;
    DEFINE INDEX IF NOT EXISTS cart_import_project_id ON cart_import FIELDS project_id;
    -- One row per distinct edge — same source+target via two different
    -- specifiers (re-export shims, aliased imports) are still separate
    -- edges and stay as separate rows.
    DEFINE INDEX IF NOT EXISTS cart_import_project_id_edge ON cart_import
      FIELDS project_id, source_path, target_path, specifier UNIQUE;
    DEFINE INDEX IF NOT EXISTS cart_git_state_project_id ON cart_git_state FIELDS project_id;
  `);

  log.info({ elapsed: `${Date.now() - start}ms` }, "schema initialized");
}
