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
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);

  const getProfile = () =>
    db
      .query("SELECT * FROM user_profile ORDER BY created_at ASC")
      .all() as UserProfileEntry[];

  const addProfileEntry = (content: string) =>
    db
      .query("INSERT INTO user_profile (content) VALUES (?) RETURNING *")
      .get(content) as UserProfileEntry;

  const removeProfileEntry = (id: number) => {
    const result = db.query("DELETE FROM user_profile WHERE id = ?").run(id);
    return result.changes > 0;
  };

  const getMemories = () =>
    db
      .query("SELECT * FROM user_memories ORDER BY created_at DESC")
      .all() as UserMemoryEntry[];

  const searchMemories = (query: string) =>
    db
      .query(
        "SELECT m.* FROM user_memories m JOIN user_memories_fts f ON m.id = f.rowid WHERE f.content MATCH ? ORDER BY f.rank",
      )
      .all(query) as UserMemoryEntry[];

  const addMemory = (content: string) =>
    db
      .query("INSERT INTO user_memories (content) VALUES (?) RETURNING *")
      .get(content) as UserMemoryEntry;

  const updateMemory = (id: number, content: string) =>
    db
      .query(
        "UPDATE user_memories SET content = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
      )
      .get(content, id) as UserMemoryEntry | null;

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
