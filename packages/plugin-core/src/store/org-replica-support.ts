/**
 * Pure support layer for the org-memory replica: schema DDL, id generation,
 * embedding blob codecs, scoring-adjacent math, and FTS query escaping.
 * Extracted from org-replica.ts to keep the store module focused (and under
 * the file-length cap); org-replica.ts re-exports the public pieces so
 * consumers import from one place.
 */

import { join } from "node:path";
import { mimirHome } from "../util";

const ORG_REPLICA_FILENAME = "org-replica.db";

/** Canonical replica location; MIMIR_ORG_REPLICA_DB overrides at call sites
 *  that read env (hooks, MCP server) — this is only the default. */
export const defaultOrgReplicaPath = () =>
  join(mimirHome(), ORG_REPLICA_FILENAME);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  project_id TEXT,
  type TEXT NOT NULL DEFAULT 'fact',
  name TEXT,
  trigger TEXT,
  message_count INTEGER,
  last_message_id TEXT,
  token_count INTEGER,
  confidence REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 1,
  tombstone INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);

CREATE TABLE IF NOT EXISTS sync_state (
  org_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relates_to (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  weight REAL NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'relates_to',
  PRIMARY KEY (from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_relates_to_to ON relates_to(to_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memory',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF content ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

/**
 * Idempotent sync-column migration for replicas created before MIM-88.
 * SQLite CREATE TABLE IF NOT EXISTS never alters an existing table, so
 * pre-sync databases need the three columns added in place. Existing
 * rows land dirty=1 deliberately: the first sync pushes the whole
 * replica — exactly the MIM-92 cutover semantics.
 */
export const migrateSyncSchema = (db: {
  query: (sql: string) => { all: () => unknown[] };
  run: (sql: string) => unknown;
}) => {
  const columns = new Set(
    (
      db.query("PRAGMA table_info(memory)").all() as Array<{ name: string }>
    ).map((c) => c.name),
  );
  if (!columns.has("version")) {
    db.run("ALTER TABLE memory ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.has("dirty")) {
    db.run("ALTER TABLE memory ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.has("tombstone")) {
    db.run(
      "ALTER TABLE memory ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0",
    );
  }
  // Index lives here, not in SCHEMA: on a legacy database the column
  // does not exist until the ALTERs above have run.
  db.run("CREATE INDEX IF NOT EXISTS idx_memory_dirty ON memory(dirty)");
};

const MEMORY_ID_PREFIX = "memory:";
const MEMORY_ID_LENGTH = 20;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Server-style record id ("memory:<20 lowercase alnum>") so locally
 *  created rows are indistinguishable from imported ones. */
export const generateMemoryId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(MEMORY_ID_LENGTH));
  let suffix = "";
  for (const b of bytes) suffix += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${MEMORY_ID_PREFIX}${suffix}`;
};

export const embeddingToBlob = (embedding: number[]) =>
  new Uint8Array(Float32Array.from(embedding).buffer);

export const blobToEmbedding = (blob: Uint8Array) =>
  new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

/** Cosine DISTANCE (0 = identical, ascending = nearest first) — matches the
 *  server's `1 - vector::similarity::cosine` projection. */
export const cosineDistance = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return 1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

/** Freshness decay — verbatim port of goldfish/store.ts computeFreshness. */
export const computeFreshness = (lastAccessed?: string | null) => {
  if (!lastAccessed) return 1.0;
  const now = Date.now();
  const accessed = new Date(lastAccessed).getTime();
  const daysSinceAccess = (now - accessed) / (1000 * 60 * 60 * 24);
  const halfLifeDays = 30;
  const decay = Math.exp((-daysSinceAccess * Math.LN2) / halfLifeDays);
  return Math.max(0.1, decay);
};

/**
 * OR-joined so any term can match — a natural-language prompt rarely has
 * every word present in a memory (SurrealDB's analyzer match is similarly
 * permissive; BM25 ranking sorts the noise out). AND-conjunction was tried
 * first and made single unmatched tokens ("JWTs" vs "JWT") zero the result.
 *
 * FTS5 MATCH treats bare punctuation as query syntax; a natural-language
 * prompt like "what's the auth flow?" would be a syntax error. Quote each
 * token so every query is a plain term disjunction.
 */
/** Embed-source rule, shared by store-time embedding (tools/org-memory)
 *  and the MIM-85 backfill so the two can never drift: playbooks embed
 *  name+trigger (the matching key), everything else its content. */
export const memoryEmbedSource = (memory: {
  readonly type: string;
  readonly name?: string | null;
  readonly trigger?: string | null;
  readonly content: string;
}) =>
  memory.type === "playbook" && memory.trigger
    ? `${memory.name ?? ""}\n${memory.trigger}`.trim()
    : memory.content;

export const escapeFtsQuery = (query: string) =>
  query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" OR ");
