/**
 * User-memory SQLite store. Schema is intentionally identical across all
 * Mimir adapters so a SQLite file written by one is readable by another.
 *
 * Backed by bun:sqlite — included in the Bun runtime, no extra deps.
 * Two tables (`user_profile`, `user_memories`) plus an FTS5 virtual table
 * and triggers for full-text search. PRAGMA journal_mode=WAL keeps reads
 * concurrent with writes; foreign_keys=ON is the default.
 * Opening a database with an old unstemmed search index rebuilds that index.
 */

import { Database } from "bun:sqlite";
import { expandHomePath } from "../util";
import { escapeFtsQuery } from "./org-replica-support";

// Porter stemming so "preference" finds "Prefers"; unicode61 is FTS5's
// default tokenizer, kept underneath so token boundaries do not change.
const STEMMING_TOKENIZER = "porter unicode61";

// An OR-of-words query matches on common words too; the cap keeps a
// conversational question from returning most of the store.
const SEARCH_RESULT_CAP = 10;

// The MCP server and a hook can open the database at the same moment; a
// second opener waits this long for the first one's write lock instead of
// failing with SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS user_memories_fts USING fts5(
  content,
  content='user_memories',
  content_rowid='id',
  tokenize='${STEMMING_TOKENIZER}'
);

CREATE TRIGGER IF NOT EXISTS user_memories_ai AFTER INSERT ON user_memories BEGIN
  INSERT INTO user_memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS user_memories_ad AFTER DELETE ON user_memories BEGIN
  INSERT INTO user_memories_fts(user_memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS user_memories_au AFTER UPDATE ON user_memories BEGIN
  INSERT INTO user_memories_fts(user_memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO user_memories_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

export type UserProfileEntry = {
  readonly id: number;
  readonly content: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type UserMemoryEntry = {
  readonly id: number;
  readonly content: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type UserMemoryStore = {
  readonly getProfile: () => UserProfileEntry[];
  readonly addProfileEntry: (content: string) => UserProfileEntry;
  readonly removeProfileEntry: (id: number) => boolean;
  readonly getMemories: () => UserMemoryEntry[];
  readonly searchMemories: (query: string) => UserMemoryEntry[];
  readonly addMemory: (content: string) => UserMemoryEntry;
  readonly updateMemory: (
    id: number,
    content: string,
  ) => UserMemoryEntry | null;
  readonly deleteMemory: (id: number) => boolean;
  readonly close: () => void;
  readonly getProfileAsText: () => string | null;
};

/**
 * CREATE ... IF NOT EXISTS never alters an existing FTS table, so a database
 * created before stemming keeps its unstemmed index. The index is
 * external-content (it stores no rows of its own), so dropping and
 * rebuilding it from user_memories touches no memory or profile row.
 */
const needsStemmedFtsMigration = (db: Database) => {
  const existing = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_memories_fts'",
    )
    .get();
  return existing !== null && !existing.sql.includes(STEMMING_TOKENIZER);
};

const migrateToStemmedFts = (db: Database) => {
  if (!needsStemmedFtsMigration(db)) return;
  // IMMEDIATE takes the write lock before re-checking, so a process that
  // lost the race to another opener sees the migrated table and stops.
  db.transaction(() => {
    if (!needsStemmedFtsMigration(db)) return;
    db.run("DROP TABLE user_memories_fts");
    db.run(SCHEMA);
    db.run(
      "INSERT INTO user_memories_fts(user_memories_fts) VALUES ('rebuild')",
    );
  }).immediate();
};

export const createUserMemoryStore = (dbPath: string) => {
  const db = new Database(expandHomePath(dbPath));
  db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  migrateToStemmedFts(db);
  db.run(SCHEMA);

  const getProfile = () =>
    db
      .query<UserProfileEntry, []>(
        "SELECT * FROM user_profile ORDER BY created_at ASC",
      )
      .all();

  const addProfileEntry = (content: string) => {
    const row = db
      .query<UserProfileEntry, [string]>(
        "INSERT INTO user_profile (content) VALUES (?) RETURNING *",
      )
      .get(content);
    if (!row) throw new Error("INSERT INTO user_profile returned no row");
    return row;
  };

  const removeProfileEntry = (id: number) => {
    const result = db.query("DELETE FROM user_profile WHERE id = ?").run(id);
    return result.changes > 0;
  };

  const getMemories = () =>
    db
      .query<UserMemoryEntry, []>(
        "SELECT * FROM user_memories ORDER BY created_at DESC",
      )
      .all();

  // Queries are natural language, not FTS5 syntax: escapeFtsQuery quotes
  // each word and ORs them, and BM25 rank puts multi-term matches first.
  const searchMemories = (query: string) => {
    const ftsQuery = escapeFtsQuery(query);
    if (ftsQuery.length === 0) return [];
    return db
      .query<UserMemoryEntry, [string, number]>(
        "SELECT m.* FROM user_memories m JOIN user_memories_fts f ON m.id = f.rowid WHERE f.content MATCH ? ORDER BY f.rank LIMIT ?",
      )
      .all(ftsQuery, SEARCH_RESULT_CAP);
  };

  const addMemory = (content: string) => {
    const row = db
      .query<UserMemoryEntry, [string]>(
        "INSERT INTO user_memories (content) VALUES (?) RETURNING *",
      )
      .get(content);
    if (!row) throw new Error("INSERT INTO user_memories returned no row");
    return row;
  };

  const updateMemory = (id: number, content: string) =>
    db
      .query<UserMemoryEntry | null, [string, number]>(
        "UPDATE user_memories SET content = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
      )
      .get(content, id);

  const deleteMemory = (id: number) => {
    const result = db.query("DELETE FROM user_memories WHERE id = ?").run(id);
    return result.changes > 0;
  };

  const close = () => {
    db.close();
  };

  const getProfileAsText = () => {
    const profile = getProfile();
    if (profile.length === 0) return null;
    return profile.map((p) => p.content).join("\n");
  };

  return {
    getProfile,
    addProfileEntry,
    removeProfileEntry,
    getMemories,
    searchMemories,
    addMemory,
    updateMemory,
    deleteMemory,
    close,
    getProfileAsText,
  };
};
