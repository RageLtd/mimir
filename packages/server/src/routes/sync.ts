/**
 * Blind sync routes (MIM-88) — jobs three and four of the reduced
 * server: ciphertext sync and blind coordination.
 *
 *   POST   /v1/sync/push  — LWW upsert of wire envelopes (opaque payloads)
 *   GET    /v1/sync/pull  — envelopes since cursor, ordered by seq
 *   POST   /v1/sync/lease — content-free coordination lease (acquire)
 *   DELETE /v1/sync/lease — release a held lease
 *
 * The server validates envelope FIELD shapes only; the payload is an
 * opaque string stored and served verbatim — never parsed, never logged.
 * LWW rule: incoming.version > stored → accept; == → accept (the server
 * assigns updated_at, so the later push wins the tie — that is what
 * last-write-wins means); < → skip, reported as stale so the client
 * knows to pull the winner.
 *
 * Works in both deployment modes: auth-on scopes by the identity gate's
 * org; auth-off (self-hosted) scopes to the owner sentinel with a single
 * "local" user — plaintext-suite envelopes ride the same rails (§9).
 */

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getAuthDb } from "../auth/instance";
import { config } from "../config";
import { getTenantDb, OWNER_ORG_SENTINEL } from "../db/tenant";
import type { IdentityEnv } from "../middleware/identity";
import { log } from "../util/logger";
import { attempt } from "../util/result";

const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 2000;
const MAX_PUSH_BATCH = 1000;
const MAX_LEASE_TTL_SECONDS = 3600;

type EnvelopeRow = {
  seq: number;
  id: string;
  kind: number;
  envelope_v: number;
  suite: number;
  key_gen: number;
  version: number;
  tombstone: number;
  nonce: string;
  payload: string;
};

/** Field-shape validation ONLY — the payload stays opaque. */
function readEnvelope(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    e.id.length === 0 ||
    typeof e.kind !== "number" ||
    typeof e.v !== "number" ||
    typeof e.suite !== "number" ||
    typeof e.keyGen !== "number" ||
    typeof e.version !== "number" ||
    e.version < 1 ||
    typeof e.tombstone !== "boolean" ||
    typeof e.nonce !== "string" ||
    typeof e.payload !== "string"
  ) {
    return null;
  }
  return {
    id: e.id,
    kind: e.kind,
    v: e.v,
    suite: e.suite,
    keyGen: e.keyGen,
    version: e.version,
    tombstone: e.tombstone,
    nonce: e.nonce,
    payload: e.payload,
  };
}

/** Members of an org for tombstone-GC gating. Auth-off has exactly one
 *  implicit member. Injectable for tests. */
const defaultCountOrgMembers = (orgId: string) => {
  if (!config.auth.enabled) return 1;
  const row = getAuthDb()
    .query("SELECT COUNT(*) AS n FROM member WHERE organizationId = ?")
    .get(orgId) as { n: number } | null;
  return row?.n ?? 0;
};

/**
 * Tombstone GC: once EVERY member's cursor has passed a tombstone's seq,
 * nobody still needs the deletion signal — the row can go. Gated on all
 * members having pulled at least once (a memberless cursor table would
 * otherwise GC prematurely).
 */
function gcTombstones(db: Database, orgId: string, memberCount: number) {
  if (memberCount === 0) return;
  const cursors = db
    .query<{ n: number; low: number | null }, [string]>(
      "SELECT COUNT(*) AS n, MIN(cursor) AS low FROM sync_cursor WHERE org_id = ?",
    )
    .get(orgId);
  if (!cursors || cursors.n < memberCount || cursors.low === null) return;
  db.query(
    "DELETE FROM envelope WHERE org_id = ? AND tombstone = 1 AND seq <= ?",
  ).run(orgId, cursors.low);
}

export function createSyncRoutes(
  getDb: () => Database = getTenantDb,
  countOrgMembers: (orgId: string) => number = defaultCountOrgMembers,
) {
  const sync = new Hono<IdentityEnv>();

  const who = (c: {
    get: (k: "identity") => { userId: string; orgId: string } | undefined;
  }) => {
    const identity = c.get("identity");
    return {
      orgId: identity?.orgId ?? OWNER_ORG_SENTINEL,
      userId: identity?.userId ?? "local",
    };
  };

  sync.post("/push", async (c) => {
    const { orgId } = who(c);
    const db = getDb();
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    const rawEnvelopes = Array.isArray(body.envelopes) ? body.envelopes : null;
    if (!rawEnvelopes) {
      return c.json({ error: "envelopes array is required" }, 400);
    }
    if (rawEnvelopes.length > MAX_PUSH_BATCH) {
      return c.json({ error: "push batch too large" }, 400);
    }
    const envelopes: NonNullable<ReturnType<typeof readEnvelope>>[] = [];
    for (const raw of rawEnvelopes) {
      const envelope = readEnvelope(raw);
      if (!envelope) return c.json({ error: "malformed envelope" }, 400);
      envelopes.push(envelope);
    }

    let accepted = 0;
    const stale: string[] = [];
    db.transaction(() => {
      for (const envelope of envelopes) {
        const stored = db
          .query<{ version: number }, [string, string]>(
            "SELECT version FROM envelope WHERE org_id = ? AND id = ?",
          )
          .get(orgId, envelope.id);
        if (stored && stored.version > envelope.version) {
          stale.push(envelope.id);
          continue;
        }
        // Replace = delete + insert so the record gets a fresh seq and
        // every puller past the old seq sees the update.
        db.query("DELETE FROM envelope WHERE org_id = ? AND id = ?").run(
          orgId,
          envelope.id,
        );
        db.query(
          `INSERT INTO envelope (
            id, org_id, kind, envelope_v, suite, key_gen, version,
            tombstone, nonce, payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          envelope.id,
          orgId,
          envelope.kind,
          envelope.v,
          envelope.suite,
          envelope.keyGen,
          envelope.version,
          envelope.tombstone ? 1 : 0,
          envelope.nonce,
          envelope.payload,
        );
        accepted += 1;
      }
    })();

    gcTombstones(db, orgId, countOrgMembers(orgId));

    const head = db
      .query<{ top: number | null }, [string]>(
        "SELECT MAX(seq) AS top FROM envelope WHERE org_id = ?",
      )
      .get(orgId);
    log.info({ orgId, accepted, stale: stale.length }, "sync: push");
    return c.json({ accepted, stale, cursor: head?.top ?? 0 });
  });

  sync.get("/pull", (c) => {
    const { orgId, userId } = who(c);
    const db = getDb();
    const since = Number.parseInt(c.req.query("since") ?? "0", 10);
    const rawLimit = Number.parseInt(
      c.req.query("limit") ?? String(DEFAULT_PULL_LIMIT),
      10,
    );
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(rawLimit)) {
      return c.json(
        { error: "since and limit must be non-negative integers" },
        400,
      );
    }
    const limit = Math.min(Math.max(rawLimit, 1), MAX_PULL_LIMIT);
    const rows = db
      .query<EnvelopeRow, [string, number, number]>(
        `SELECT seq, id, kind, envelope_v, suite, key_gen, version,
                tombstone, nonce, payload
         FROM envelope WHERE org_id = ? AND seq > ?
         ORDER BY seq LIMIT ?`,
      )
      .all(orgId, since, limit);

    // Record the caller's CONFIRMED cursor (`since` — what they have
    // durably applied), not the batch we are about to hand them: if they
    // crash mid-apply, tombstone GC must not have advanced past them.
    db.query(
      `INSERT INTO sync_cursor (org_id, user_id, cursor, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(org_id, user_id) DO UPDATE SET
         cursor = MAX(sync_cursor.cursor, excluded.cursor),
         updated_at = excluded.updated_at`,
    ).run(orgId, userId, since);

    const last = rows[rows.length - 1];
    return c.json({
      orgId,
      envelopes: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        v: r.envelope_v,
        suite: r.suite,
        keyGen: r.key_gen,
        version: r.version,
        tombstone: r.tombstone === 1,
        nonce: r.nonce,
        payload: r.payload,
      })),
      nextCursor: last ? last.seq : since,
    });
  });

  sync.post("/lease", async (c) => {
    const { orgId, userId } = who(c);
    const db = getDb();
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    const name = typeof body.name === "string" && body.name ? body.name : null;
    const ttl =
      typeof body.ttlSeconds === "number" && body.ttlSeconds > 0
        ? Math.min(body.ttlSeconds, MAX_LEASE_TTL_SECONDS)
        : null;
    if (!name || !ttl) {
      return c.json({ error: "name and ttlSeconds are required" }, 400);
    }
    const now = Date.now();
    const expiresAt = now + ttl * 1000;
    const acquired = db.transaction(() => {
      const row = db
        .query<{ holder: string; expires_at: number }, [string, string]>(
          "SELECT holder, expires_at FROM lease WHERE org_id = ? AND name = ?",
        )
        .get(orgId, name);
      if (row && row.expires_at > now && row.holder !== userId) return false;
      db.query(
        `INSERT INTO lease (org_id, name, holder, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, name) DO UPDATE SET
           holder = excluded.holder, expires_at = excluded.expires_at`,
      ).run(orgId, name, userId, expiresAt);
      return true;
    })();
    if (!acquired) {
      log.info({ orgId, name }, "sync: lease held elsewhere");
      return c.json({ acquired: false }, 409);
    }
    return c.json({ acquired: true, expiresAt });
  });

  sync.delete("/lease", async (c) => {
    const { orgId, userId } = who(c);
    const db = getDb();
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    const name = typeof body.name === "string" && body.name ? body.name : null;
    if (!name) return c.json({ error: "name is required" }, 400);
    db.query(
      "DELETE FROM lease WHERE org_id = ? AND name = ? AND holder = ?",
    ).run(orgId, name, userId);
    return c.json({ ok: true });
  });

  return sync;
}

export const sync = createSyncRoutes();
