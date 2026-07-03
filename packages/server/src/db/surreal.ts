import { Surreal } from "surrealdb";
import { config } from "../config";
import { log } from "../util/logger";
import { attempt } from "../util/result";

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
    "project",
    "file_path",
    "language",
    "symbols",
    "searchable",
    "content_hash",
    "indexed_at",
  ],
  cart_import: [
    "project",
    "source_path",
    "target_path",
    "specifier",
    "symbols",
    "indexed_at",
  ],
};

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
 * Drop any live cart_file / cart_import field the schema no longer declares.
 * Runs after the DEFINE block in initSchema. Returns the statements executed
 * so the caller can log what was pruned. No-op on a clean schema.
 */
const removeDriftedCartFields = async (db: Surreal) => {
  const statements: string[] = [];
  for (const [table, declared] of Object.entries(CART_DECLARED_FIELDS)) {
    const live = await liveTableFields(db, table);
    statements.push(...buildDriftRemovalSql(table, live, declared));
  }
  if (statements.length > 0) {
    await db.query(statements.join("\n"));
  }
  return statements;
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
    DEFINE FIELD IF NOT EXISTS project ON memory TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS created_at ON memory TYPE datetime DEFAULT time::now();
    DEFINE FIELD IF NOT EXISTS last_accessed ON memory TYPE datetime DEFAULT time::now();
    DEFINE FIELD IF NOT EXISTS confidence ON memory TYPE float DEFAULT 1.0;
    DEFINE FIELD IF NOT EXISTS access_count ON memory TYPE int DEFAULT 0;
    DEFINE FIELD IF NOT EXISTS embedding ON memory TYPE array<float>;
    DEFINE INDEX IF NOT EXISTS memory_ft ON memory FIELDS content
      FULLTEXT ANALYZER memory_analyzer BM25;
    DEFINE INDEX IF NOT EXISTS memory_vec ON memory FIELDS embedding
      HNSW DIMENSION 1024 DIST COSINE;

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
    -- Global append-only log keyed by [project, timestamp]
    -- Enables efficient time-range queries for context assembly
    --
    -- Project keying:
    --   project (string)     - legacy cwd-style path. Always populated for
    --                          back-compat; pre-Slice-2 rows have only this.
    --   project_id (option)  - canonical UUID from /v1/projects/resolve.
    --                          Populated by Slice-2-aware clients alongside
    --                          project. Future queries should prefer this
    --                          when present. New column is optional so old
    --                          rows remain valid without backfill.
    DEFINE TABLE IF NOT EXISTS message_log SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS project ON message_log TYPE string;
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

    -- Cartographer tables
    DEFINE TABLE IF NOT EXISTS cart_file SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS file_path ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS language ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS symbols ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS searchable ON cart_file TYPE string;
    -- SHA-256 hex of the file contents at sync time. Clients compute and
    -- send this so the server can detect stale-index conditions without
    -- needing filesystem access to the source tree.
    DEFINE FIELD IF NOT EXISTS content_hash ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_file TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_file_project ON cart_file FIELDS project;
    DEFINE INDEX IF NOT EXISTS cart_file_path ON cart_file FIELDS file_path;
    -- Sync uses a full DELETE-then-INSERT per project, so one row per
    -- (project, file_path) pair is the invariant. The UNIQUE index makes
    -- it a hard constraint rather than a convention waiting to fail.
    DEFINE INDEX IF NOT EXISTS cart_file_unique ON cart_file
      FIELDS project, file_path UNIQUE;
    DEFINE INDEX IF NOT EXISTS cart_file_searchable ON cart_file FIELDS searchable
      FULLTEXT ANALYZER memory_analyzer BM25;

    DEFINE TABLE IF NOT EXISTS cart_import SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS source_path ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS target_path ON cart_import TYPE string;
    -- Raw import specifier string as it appears in source ("./util",
    -- "react", "../config"). Distinct from target_path, which is the
    -- resolved absolute path. Authored-side identity matters for
    -- detecting refactors and for the (project, source, target,
    -- specifier) UNIQUE edge.
    DEFINE FIELD IF NOT EXISTS specifier ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS symbols ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_import TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_import_project ON cart_import FIELDS project;
    DEFINE INDEX IF NOT EXISTS cart_import_source ON cart_import FIELDS source_path;
    DEFINE INDEX IF NOT EXISTS cart_import_target ON cart_import FIELDS target_path;
    -- One row per distinct edge — same source+target via two different
    -- specifiers (re-export shims, aliased imports) are still separate
    -- edges and stay as separate rows.
    DEFINE INDEX IF NOT EXISTS cart_import_edge ON cart_import
      FIELDS project, source_path, target_path, specifier UNIQUE;

    DEFINE TABLE IF NOT EXISTS cart_git_state SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project ON cart_git_state TYPE string;
    DEFINE FIELD IF NOT EXISTS git_head ON cart_git_state TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_git_state TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_git_state_project ON cart_git_state FIELDS project;

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

  const pruned = await removeDriftedCartFields(db);
  if (pruned.length > 0) {
    log.warn(
      { pruned },
      "converged cartographer schema — removed drifted fields",
    );
  }

  log.info({ elapsed: `${Date.now() - start}ms` }, "schema initialized");
}
