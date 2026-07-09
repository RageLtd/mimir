/**
 * Tenant store (MIM-88) — one SQLite file holding everything the reduced
 * server keeps per tenant: ciphertext envelopes, sync cursors, blind-
 * coordination leases, and the project registry. This is the "blob store
 * simplifies further" option from the ticket: dumb rows, monotonic
 * AUTOINCREMENT seq as the sync cursor, bun:sqlite transactions for LWW
 * CAS. SurrealDB exits the runtime with this module's arrival; upgrading
 * to Postgres later is a driver swap, not an architecture change.
 *
 * Envelope payloads are OPAQUE — stored and served verbatim, never
 * parsed, never logged (THREAT_MODEL §6: the server may index envelope
 * fields; it never reads the payload).
 */

import { Database } from "bun:sqlite";
import { config } from "../config";

/**
 * The org id that pre-auth / self-hosted data belongs to (relocated from
 * db/scope.ts as Surreal exits). Auth-off boots scope every row to this
 * stable literal; a Better Auth org id is a nanoid and never collides.
 */
export const OWNER_ORG_SENTINEL = "owner";

export const TENANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS envelope (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  kind INTEGER NOT NULL,
  envelope_v INTEGER NOT NULL,
  suite INTEGER NOT NULL,
  key_gen INTEGER NOT NULL,
  version INTEGER NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  nonce TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(org_id, id)
);
CREATE INDEX IF NOT EXISTS idx_envelope_org_seq ON envelope(org_id, seq);

CREATE TABLE IF NOT EXISTS sync_cursor (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS lease (
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'owner',
  git_remote TEXT,
  local_path TEXT,
  title TEXT,
  description TEXT,
  technologies TEXT,
  purpose TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_org_remote ON project(org_id, git_remote);
CREATE INDEX IF NOT EXISTS idx_project_org_path ON project(org_id, local_path);
`;

/** Build a tenant database at the given path — the test seam
 *  (":memory:") and the singleton's constructor. */
export function createTenantDb(path: string) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run(TENANT_SCHEMA);
  return db;
}

let handle: Database | null = null;

/** Lazy singleton on config.tenantDbPath — mirrors auth/instance.ts's
 *  getAuthDb discipline. */
export function getTenantDb() {
  if (!handle) {
    handle = createTenantDb(config.tenantDbPath);
  }
  return handle;
}

/** Test seam — inject an in-memory tenant db so store tests never touch
 *  the config-driven file. Pass null to restore the lazy default. */
export function _setTenantDbForTests(db: Database | null) {
  handle = db;
}
