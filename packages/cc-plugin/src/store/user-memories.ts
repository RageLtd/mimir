/**
 * User-memory SQLite store. Ported verbatim from
 * packages/acp/src/store/user-memories.ts — bun:sqlite is included in the
 * compiled binary so no extra deps required.
 *
 * The schema mirrors the monorepo so a SQLite file written by mimir-acp is
 * readable by mimir-cc and vice versa.
 */

import { Database } from "bun:sqlite";

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
  content_rowid='id'
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

export const createUserMemoryStore = (dbPath: string) => {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
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

  const searchMemories = (query: string) =>
    db
      .query<UserMemoryEntry, [string]>(
        "SELECT m.* FROM user_memories m JOIN user_memories_fts f ON m.id = f.rowid WHERE f.content MATCH ? ORDER BY f.rank",
      )
      .all(query);

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
