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

/** Run once at startup to ensure schema exists */
export async function initSchema(): Promise<void> {
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

    -- Memory relationships
    DEFINE TABLE IF NOT EXISTS relates_to SCHEMAFULL TYPE RELATION FROM memory TO memory;
    DEFINE FIELD IF NOT EXISTS weight ON relates_to TYPE float;
    DEFINE FIELD IF NOT EXISTS relation_type ON relates_to TYPE string;

    -- Message log (Phase 6: Single Brain Architecture)
    -- Global append-only log keyed by [project, timestamp]
    -- Enables efficient time-range queries for context assembly
    DEFINE TABLE IF NOT EXISTS message_log SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS project ON message_log TYPE string;
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

    -- Cartographer tables
    DEFINE TABLE IF NOT EXISTS cart_file SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS file_path ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS language ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS symbols ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS searchable ON cart_file TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_file TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_file_project ON cart_file FIELDS project;
    DEFINE INDEX IF NOT EXISTS cart_file_path ON cart_file FIELDS file_path;
    DEFINE INDEX IF NOT EXISTS cart_file_searchable ON cart_file FIELDS searchable FULLTEXT;

    DEFINE TABLE IF NOT EXISTS cart_import SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS source_path ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS target_path ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS symbols ON cart_import TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_import TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_import_project ON cart_import FIELDS project;
    DEFINE INDEX IF NOT EXISTS cart_import_source ON cart_import FIELDS source_path;
    DEFINE INDEX IF NOT EXISTS cart_import_target ON cart_import FIELDS target_path;

    DEFINE TABLE IF NOT EXISTS cart_git_state SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS project ON cart_git_state TYPE string;
    DEFINE FIELD IF NOT EXISTS git_head ON cart_git_state TYPE string;
    DEFINE FIELD IF NOT EXISTS indexed_at ON cart_git_state TYPE datetime DEFAULT time::now();
    DEFINE INDEX IF NOT EXISTS cart_git_state_project ON cart_git_state FIELDS project;
  `);

  log.info({ elapsed: `${Date.now() - start}ms` }, "schema initialized");
}
