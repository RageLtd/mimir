/**
 * Session persistence store.
 *
 * Persists ACP session state to SQLite so sessions survive ACP process
 * restarts. Stores per-session: id, projectPath, modelId, mode, title,
 * and the full message history (JSON-serialised).
 *
 * Messages are written in bulk after each prompt round-trip, not per-message,
 * to keep write volume low.
 */

import { Database } from "bun:sqlite";
import type { ChatMessage } from "../server-client";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  project_path  TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'default',
  thought_level TEXT,
  title         TEXT,
  messages      TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Idempotent migration for `thought_level` column. Older databases created
 * before this column existed need it added. `PRAGMA table_info` returns a
 * row per column; adding via ALTER TABLE succeeds only when absent.
 */
const migrateThoughtLevelColumn = (db: Database) => {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(sessions)")
    .all();
  const hasThoughtLevel = cols.some((c) => c.name === "thought_level");
  if (!hasThoughtLevel) {
    db.exec("ALTER TABLE sessions ADD COLUMN thought_level TEXT");
  }
};

export type PersistedSession = {
  readonly session_id: string;
  readonly project_path: string;
  readonly model_id: string;
  readonly mode: string;
  readonly thought_level: string | null;
  readonly title: string | null;
  readonly messages: string; // JSON
  readonly updated_at: string;
};

export type SessionStore = {
  readonly upsert: (
    sessionId: string,
    projectPath: string,
    modelId: string,
    mode: string,
    thoughtLevel: string | null,
    title: string | null,
    messages: readonly ChatMessage[],
  ) => void;
  readonly updateMeta: (
    sessionId: string,
    fields: {
      modelId?: string;
      mode?: string;
      thoughtLevel?: string | null;
      title?: string | null;
    },
  ) => void;
  readonly updateMessages: (
    sessionId: string,
    messages: readonly ChatMessage[],
  ) => void;
  readonly get: (sessionId: string) => PersistedSession | null;
  readonly list: () => PersistedSession[];
  readonly close: () => void;
};

export const createSessionStore = (dbPath: string) => {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  migrateThoughtLevelColumn(db);

  const upsert = (
    sessionId: string,
    projectPath: string,
    modelId: string,
    mode: string,
    thoughtLevel: string | null,
    title: string | null,
    messages: readonly ChatMessage[],
  ) => {
    db.query(
      `INSERT INTO sessions (session_id, project_path, model_id, mode, thought_level, title, messages, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET
           project_path  = excluded.project_path,
           model_id      = excluded.model_id,
           mode          = excluded.mode,
           thought_level = excluded.thought_level,
           title         = excluded.title,
           messages      = excluded.messages,
           updated_at    = excluded.updated_at`,
    ).run(
      sessionId,
      projectPath,
      modelId,
      mode,
      thoughtLevel,
      title,
      JSON.stringify(messages),
    );
  };

  const updateMeta = (
    sessionId: string,
    fields: {
      modelId?: string;
      mode?: string;
      thoughtLevel?: string | null;
      title?: string | null;
    },
  ) => {
    if (fields.modelId !== undefined) {
      db.query(
        "UPDATE sessions SET model_id = ?, updated_at = datetime('now') WHERE session_id = ?",
      ).run(fields.modelId, sessionId);
    }
    if (fields.mode !== undefined) {
      db.query(
        "UPDATE sessions SET mode = ?, updated_at = datetime('now') WHERE session_id = ?",
      ).run(fields.mode, sessionId);
    }
    if ("thoughtLevel" in fields) {
      db.query(
        "UPDATE sessions SET thought_level = ?, updated_at = datetime('now') WHERE session_id = ?",
      ).run(fields.thoughtLevel ?? null, sessionId);
    }
    if ("title" in fields) {
      db.query(
        "UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE session_id = ?",
      ).run(fields.title ?? null, sessionId);
    }
  };

  const updateMessages = (
    sessionId: string,
    messages: readonly ChatMessage[],
  ) => {
    db.query(
      `UPDATE sessions SET messages = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ).run(JSON.stringify(messages), sessionId);
  };

  const get = (sessionId: string) =>
    db
      .query<PersistedSession, [string]>(
        "SELECT * FROM sessions WHERE session_id = ?",
      )
      .get(sessionId) ?? null;

  const list = () =>
    db
      .query<PersistedSession, []>(
        "SELECT * FROM sessions ORDER BY updated_at DESC",
      )
      .all();

  const close = () => {
    db.close();
  };

  return { upsert, updateMeta, updateMessages, get, list, close };
};
