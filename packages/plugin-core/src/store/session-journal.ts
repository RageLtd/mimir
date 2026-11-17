/**
 * Session journal: a per-session log of conversation messages, written a
 * turn at a time by short-lived processes, so a conversation can still be
 * summarised after the host has discarded it. A summary settles the journal
 * up to a cursor and leaves its text carried for the next one.
 *
 * Local only — it never syncs. It is its own database on purpose, apart
 * from the org replica, so nothing here can ride along with a sync push.
 *
 * Append rule: a batch lines up with a session's journal when, from some
 * position in what is already journalled, its leading messages equal the
 * journal message for message through to the journal's end, or the whole
 * batch is already there. Only what extends past the journal's end is
 * added. A batch that lines up nowhere is new and is added whole. Covered
 * messages still count as journalled. Equality is by JSON content.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { attemptSync } from "../result";
import { expandHomePath, mimirHome } from "../util";

const SESSION_JOURNAL_FILENAME = "session-journal.db";

// Several hook processes can append to one session at the same moment; a
// later one waits this long for the write lock instead of failing.
const BUSY_TIMEOUT_MS = 5000;

const NO_CURSOR = 0;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_session (
  session_id TEXT PRIMARY KEY,
  covered_seq INTEGER NOT NULL DEFAULT ${NO_CURSOR},
  carried TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_message (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  hash INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_journal_message_hash
  ON journal_message(session_id, hash, seq);
`;

export const defaultSessionJournalPath = () =>
  join(mimirHome(), SESSION_JOURNAL_FILENAME);

export type SessionJournalOptions = {
  readonly now?: () => number;
};

type BodyRow = { readonly seq: number; readonly body: string };

// The hash only narrows candidates through the index; bodies are compared
// in full, so a collision costs a comparison, never a wrong line-up.
const hashBody = (body: string) => Bun.hash.crc32(body);

const serialise = (message: unknown, index: number) => {
  const body = JSON.stringify(message);
  if (body === undefined) {
    throw new Error(
      `session journal: message ${index} has no JSON form and cannot be journalled`,
    );
  }
  return body;
};

const WAL_MODE = "wal";
const SQLITE_BUSY = "SQLITE_BUSY";
const WAL_RETRY_MS = 5;

const isBusy = (error: Error) => "code" in error && error.code === SQLITE_BUSY;

const journalMode = (db: Database) =>
  db
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()
    ?.journal_mode.toLowerCase();

// Switching a fresh file to WAL needs an exclusive lock, and SQLite fails
// that switch with SQLITE_BUSY without consulting busy_timeout when other
// processes open the same new file at once — so the switch is retried here
// up to the same timeout. The mode persists in the file, so once any
// opener has switched, later ones skip this.
const enableWal = (db: Database) => {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  while (journalMode(db) !== WAL_MODE) {
    const [error] = attemptSync(() =>
      db.run(`PRAGMA journal_mode=${WAL_MODE}`),
    );
    if (error !== null) {
      if (!isBusy(error) || Date.now() > deadline) {
        throw new Error(
          `session journal: could not switch the database to WAL mode: ${error.message}`,
        );
      }
      Bun.sleepSync(WAL_RETRY_MS);
    }
  }
};

export const createSessionJournal = (
  dbPath: string,
  options: SessionJournalOptions = {},
) => {
  const now = options.now ?? Date.now;
  const db = new Database(expandHomePath(dbPath));
  db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  enableWal(db);
  db.run(SCHEMA);

  const lastSeqQuery = db.query<{ last: number | null }, [string]>(
    "SELECT MAX(seq) AS last FROM journal_message WHERE session_id = ?",
  );
  const candidatesQuery = db.query<{ seq: number }, [string, number]>(
    "SELECT seq FROM journal_message WHERE session_id = ? AND hash = ? ORDER BY seq",
  );
  const windowQuery = db.query<BodyRow, [string, number, number]>(
    "SELECT seq, body FROM journal_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
  );
  const insertMessage = db.query<null, [string, number, number, string]>(
    "INSERT INTO journal_message (session_id, seq, hash, body) VALUES (?, ?, ?, ?)",
  );
  const touchSession = db.query<null, [string, number]>(
    `INSERT INTO journal_session (session_id, updated_at) VALUES (?1, ?2)
     ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`,
  );
  const settleSession = db.query<null, [string, number, string, number]>(
    `INSERT INTO journal_session (session_id, covered_seq, carried, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(session_id) DO UPDATE SET
       covered_seq = MAX(covered_seq, excluded.covered_seq),
       carried = CASE WHEN excluded.covered_seq >= covered_seq
         THEN excluded.carried ELSE carried END,
       updated_at = excluded.updated_at`,
  );
  const sessionQuery = db.query<
    { covered_seq: number; carried: string | null },
    [string]
  >("SELECT covered_seq, carried FROM journal_session WHERE session_id = ?");
  const uncoveredQuery = db.query<BodyRow, [string, number]>(
    "SELECT seq, body FROM journal_message WHERE session_id = ? AND seq > ? ORDER BY seq",
  );
  const deleteMessages = db.query<null, [string]>(
    "DELETE FROM journal_message WHERE session_id = ?",
  );
  const deleteSession = db.query<null, [string]>(
    "DELETE FROM journal_session WHERE session_id = ?",
  );
  const pruneMessages = db.query<null, [number]>(
    "DELETE FROM journal_message WHERE session_id IN (SELECT session_id FROM journal_session WHERE updated_at < ?)",
  );
  const pruneSessions = db.query<null, [number]>(
    "DELETE FROM journal_session WHERE updated_at < ?",
  );

  // Seqs within a session are contiguous from 1 (appends take MAX+1; drop
  // and prune remove a session whole), so a window shorter than the batch
  // means it ran into the journal's end.
  const lineUp = (sessionId: string, bodies: readonly string[]) => {
    const first = bodies[0];
    if (first === undefined) return 0;
    for (const { seq } of candidatesQuery.all(sessionId, hashBody(first))) {
      const window = windowQuery.all(sessionId, seq, seq + bodies.length);
      if (window.every((row, i) => row.body === bodies[i])) {
        return window.length;
      }
    }
    return 0;
  };

  const appendLocked = (sessionId: string, bodies: readonly string[]) => {
    const overlap = lineUp(sessionId, bodies);
    const lastSeq = lastSeqQuery.get(sessionId)?.last ?? NO_CURSOR;
    const added = bodies.slice(overlap);
    added.forEach((body, i) => {
      insertMessage.run(sessionId, lastSeq + 1 + i, hashBody(body), body);
    });
    touchSession.run(sessionId, now());
    return added.length;
  };

  /** Journals what `messages` adds past the session's journal; returns how
   *  many messages were added. */
  const append = (sessionId: string, messages: readonly unknown[]) => {
    if (messages.length === 0) return 0;
    const bodies = messages.map(serialise);
    // IMMEDIATE takes the write lock before the line-up is read, so two
    // processes can never both decide against the same journal end.
    return db.transaction(() => appendLocked(sessionId, bodies)).immediate();
  };

  const readUncovered = (sessionId: string) =>
    db
      .transaction(() => {
        const session = sessionQuery.get(sessionId);
        const covered = session?.covered_seq ?? NO_CURSOR;
        const rows = uncoveredQuery.all(sessionId, covered);
        const last = rows.at(-1);
        return {
          messages: rows.map((row) => JSON.parse(row.body) as unknown),
          cursor: last === undefined ? covered : last.seq,
          carried: session?.carried ?? null,
        };
      })
      .deferred();

  /** Marks the session covered through `cursor` and carries `text`. A
   *  settle behind the stored cursor (a slower, older summary run) keeps the
   *  newer summary's text, but still counts as activity for `prune`. */
  const settle = (sessionId: string, cursor: number, text: string) => {
    settleSession.run(sessionId, cursor, text, now());
  };

  const drop = (sessionId: string) => {
    db.transaction(() => {
      deleteMessages.run(sessionId);
      deleteSession.run(sessionId);
    }).immediate();
  };

  /** Removes every session not written for longer than `maxIdleMs`. */
  const prune = (maxIdleMs: number) => {
    const cutoff = now() - maxIdleMs;
    db.transaction(() => {
      pruneMessages.run(cutoff);
      pruneSessions.run(cutoff);
    }).immediate();
  };

  const close = () => {
    db.close();
  };

  return { append, readUncovered, settle, drop, prune, close };
};
