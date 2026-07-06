import { Surreal } from "surrealdb";
import {
  buildDefineAccessSql,
  buildTablePermissionsSql,
} from "../auth/surreal-bridge";
import { config } from "../config";
import { log } from "../util/logger";
import { attempt } from "../util/result";
import { withTimeout } from "../util/timeout";
import { migrateOrgScope, ORG_SCOPED_TABLES } from "./migrate-org-scope";
import { migrateLegacyProjectKeys } from "./migrate-project-keys";
import {
  ensureEmbeddingIndexDimension,
  removeDriftedCartFields,
} from "./schema-drift";

let db: Surreal | null = null;

async function connect() {
  log.info(
    {
      url: config.surreal.url,
      ns: config.surreal.namespace,
      db: config.surreal.database,
    },
    "connecting to SurrealDB",
  );

  // The SDK exposes no connect timeout (MIM-79) — without a deadline here,
  // a refused/hanging upstream stalls every request for 60s+ at the
  // transport layer instead of failing fast with a nameable error.
  const instance = new Surreal();
  const [err] = await attempt(() =>
    withTimeout(
      (async () => {
        await instance.connect(config.surreal.url);
        await instance.signin({
          username: config.surreal.user,
          password: config.surreal.pass,
        });
        await instance.use({
          namespace: config.surreal.namespace,
          database: config.surreal.database,
        });
      })(),
      config.surreal.timeoutMs,
      "SurrealDB connect",
    ),
  );
  if (err) {
    // The abandoned handshake may still hold a socket — close best-effort.
    instance
      .close()
      .catch((closeErr: unknown) =>
        log.debug(
          { err: String(closeErr) },
          "close of failed SurrealDB connection",
        ),
      );
    throw err;
  }

  log.info("SurrealDB connection established");
  return instance;
}

async function isAlive(instance: Surreal) {
  const [err] = await attempt(() =>
    withTimeout(
      instance.query("RETURN true"),
      config.surreal.timeoutMs,
      "SurrealDB liveness probe",
    ),
  );
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

/**
 * Open a SCOPED connection authenticated with a bridge-minted JWT (MIM-70
 * slice 4). Runs under the mimir_user access method — once MIM-69 lands
 * PERMISSIONS, this session can only see rows its $token.org_id owns. The
 * root connection above stays untouched for boot migrations and background
 * work. Caller owns the connection and MUST close() it; per-request pooling
 * is MIM-69's design territory.
 */
export async function connectScoped(token: string) {
  const instance = new Surreal();
  const [err] = await attempt(() =>
    withTimeout(
      (async () => {
        await instance.connect(config.surreal.url);
        await instance.use({
          namespace: config.surreal.namespace,
          database: config.surreal.database,
        });
        await instance.authenticate(token);
      })(),
      config.surreal.timeoutMs,
      "SurrealDB scoped connect",
    ),
  );
  if (err) {
    instance
      .close()
      .catch((closeErr: unknown) =>
        log.debug(
          { err: String(closeErr) },
          "close of failed scoped SurrealDB connection",
        ),
      );
    throw err;
  }
  return instance;
}

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
export async function initSchema() {
  const start = Date.now();
  const db = await getDb();

  // Surreal record-access bridge (MIM-70 slice 4) — OVERWRITE so secret
  // rotation takes effect at boot. Dormant until MIM-69 binds PERMISSIONS
  // to $token claims; unset secret means no access method at all.
  if (config.auth.surrealAccessSecret) {
    await db.query(buildDefineAccessSql(config.auth.surrealAccessSecret));
    log.info("Surreal JWT access method defined (mimir_user)");
  }

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

    -- MIM-69 org scoping: every tenant table carries its owning org id.
    -- option<string> so pre-backfill rows validate on the SCHEMAFULL tables;
    -- migrateOrgScope (below) backfills it. project_id stays the intra-org
    -- key; org_id is the tenant boundary the row-level PERMISSIONS bind to.
    DEFINE FIELD IF NOT EXISTS org_id ON memory TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON relates_to TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON message_log TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON compaction_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON hygiene_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON cart_file TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON cart_import TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON cart_git_state TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS org_id ON project TYPE option<string>;
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

  // Backfill org_id onto every tenant row, remap sentinel rows onto the real
  // owner org post-claim, and merge duplicate project records by git_remote.
  // Runs after the legacy-key migration so project_id is populated before the
  // dedupe reassigns it, and before the index block below (non-unique org
  // indexes build over populated org_id).
  await migrateOrgScope(db);

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

    -- MIM-69 org-scoped read paths. Composite (org_id, project_id) so an
    -- org-only filter uses the leftmost prefix and an (org, project) filter
    -- uses the whole key. relates_to and project have no project_id, so they
    -- index org_id alone. compaction_state/hygiene_state indexes land in the
    -- slice that re-keys them per (org, project) (MIM-66 fold-in).
    DEFINE INDEX IF NOT EXISTS memory_org_project ON memory FIELDS org_id, project_id;
    DEFINE INDEX IF NOT EXISTS message_log_org_project ON message_log FIELDS org_id, project_id;
    DEFINE INDEX IF NOT EXISTS cart_file_org_project ON cart_file FIELDS org_id, project_id;
    DEFINE INDEX IF NOT EXISTS cart_import_org_project ON cart_import FIELDS org_id, project_id;
    DEFINE INDEX IF NOT EXISTS cart_git_state_org_project ON cart_git_state FIELDS org_id, project_id;
    DEFINE INDEX IF NOT EXISTS relates_to_org ON relates_to FIELDS org_id;
    DEFINE INDEX IF NOT EXISTS project_org ON project FIELDS org_id;
  `);

  // MIM-69 slice 5: row-level org PERMISSIONS. ALTER (not DEFINE TABLE
  // OVERWRITE) so the existing DEFINE FIELD + index definitions survive
  // untouched — verified against the SurrealDB docs. Only the scoped
  // mimir_user JWT sessions are subject to these; the root connection (boot,
  // background sweeps, fire-and-forget jobs) bypasses table permissions by
  // Surreal design. Guarded by the same secret that defines the access method:
  // no secret means no scoped sessions exist, so the tables keep their default
  // permissions and the root-only path is byte-identical to before.
  if (config.auth.surrealAccessSecret) {
    await db.query(buildTablePermissionsSql(ORG_SCOPED_TABLES));
    log.info(
      { tables: ORG_SCOPED_TABLES.length },
      "Surreal row-level org PERMISSIONS applied",
    );
  }

  log.info({ elapsed: `${Date.now() - start}ms` }, "schema initialized");
}
