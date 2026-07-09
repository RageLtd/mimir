/**
 * Wrapped-key distribution routes (MIM-87) — one of the four sanctioned
 * server jobs under the operator-blind architecture (THREAT_MODEL §1):
 * auth, WRAPPED-KEY DISTRIBUTION, ciphertext sync, blind coordination.
 *
 * Every key payload accepted or served here is ciphertext the server
 * cannot open (sealed boxes wrapped to member public keys) or content-free
 * metadata (the key generation — an accepted §7 residual). Better Auth has
 * no endpoint that writes ANOTHER member's row, and rotation must replace
 * every member's wrap atomically, so these routes write the key columns
 * directly on the auth SQLite store (the documented exception in
 * auth/instance.ts).
 *
 *   GET  /v1/keys/org      — key state for the caller's org
 *   POST /v1/keys/init     — founding member seeds the org key (CAS)
 *   POST /v1/keys/wrap     — deliver a wrap to a wrap-less member
 *   POST /v1/keys/rotate   — new generation, full re-wrap (revocation)
 *   POST /v1/keys/recovery — configure the org recovery keyset
 *
 * Authz derives from the identity gate (session → {userId, orgId}); the
 * caller must be a member of the resolved org. Denials are detail-free
 * (MIM-77 discipline) with reasons logged server-side.
 */

import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { getAuthDb } from "../auth/instance";
import type { IdentityEnv } from "../middleware/identity";
import { log } from "../util/logger";
import { attempt } from "../util/result";

const FORBIDDEN = { error: "Forbidden" };
const CONFLICT = { error: "Conflict" };
const NOT_FOUND = { error: "Not found" };

type MemberRow = {
  memberId: string;
  userId: string;
  email: string;
  publicKey: string | null;
  encryptedKeyset: string | null;
  wrappedOrgKey: string | null;
};

type OrgRow = {
  keyGeneration: number | null;
  recoveryPublicKey: string | null;
  wrappedRecoveryKey: string | null;
};

const asString = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** Read the org's key state — the shared substrate of every handler. */
function readOrgState(db: Database, orgId: string) {
  const org = db
    .query(
      "SELECT keyGeneration, recoveryPublicKey, wrappedRecoveryKey FROM organization WHERE id = ?",
    )
    .get(orgId) as OrgRow | null;
  if (!org) return null;
  const members = db
    .query(
      `SELECT m.id AS memberId, m.userId AS userId, u.email AS email,
              u.publicKey AS publicKey, u.encryptedKeyset AS encryptedKeyset,
              m.wrappedOrgKey AS wrappedOrgKey
       FROM member m JOIN "user" u ON u.id = m.userId
       WHERE m.organizationId = ?`,
    )
    .all(orgId) as MemberRow[];
  return { org, members };
}

const findSelf = (members: MemberRow[], userId: string) =>
  members.find((m) => m.userId === userId) ?? null;

const anyWrapped = (members: MemberRow[]) =>
  members.some((m) => m.wrappedOrgKey !== null);

/**
 * Build the sub-app. The db getter is injectable so tests run against an
 * in-memory migrated store instead of the config singleton (same pattern
 * as the identity gate's injectable session lookup).
 */
export function createKeysRoutes(getDb: () => Database = getAuthDb) {
  const keys = new Hono<IdentityEnv>();

  /** Resolve identity + org state into a discriminated result — handlers
   *  answer denials themselves (keeps Hono's per-route Context generics
   *  out of the shared helper). */
  const resolve = (c: Context<IdentityEnv>) => {
    const identity = c.get("identity");
    if (!identity) {
      // Auth-off boots have no identities and no key ceremony.
      log.warn("keys route called without identity — auth disabled?");
      return { ok: false, status: 403 } as const;
    }
    const db = getDb();
    const state = readOrgState(db, identity.orgId);
    if (!state) {
      log.warn({ orgId: identity.orgId }, "keys: organization not found");
      return { ok: false, status: 404 } as const;
    }
    const self = findSelf(state.members, identity.userId);
    if (!self) {
      log.warn(
        { orgId: identity.orgId, userId: identity.userId },
        "keys: caller is not a member of the resolved org",
      );
      return { ok: false, status: 403 } as const;
    }
    return { ok: true, identity, db, ...state, self } as const;
  };

  /** Detail-free body for a denial status. */
  const denialBody = (status: 403 | 404) =>
    status === 404 ? NOT_FOUND : FORBIDDEN;

  keys.get("/org", (c) => {
    const r = resolve(c);
    if (!r.ok) return c.json(denialBody(r.status), r.status);
    return c.json({
      initialized: r.org.keyGeneration !== null || anyWrapped(r.members),
      keyGeneration: r.org.keyGeneration,
      recoveryPublicKey: r.org.recoveryPublicKey,
      wrappedRecoveryKey: r.org.wrappedRecoveryKey,
      // Self carries the private-side ciphertext (own keyset, own wrap);
      // other members expose only what wrap delivery needs.
      self: {
        memberId: r.self.memberId,
        userId: r.self.userId,
        publicKey: r.self.publicKey,
        encryptedKeyset: r.self.encryptedKeyset,
        wrappedOrgKey: r.self.wrappedOrgKey,
      },
      members: r.members.map((m) => ({
        memberId: m.memberId,
        userId: m.userId,
        email: m.email,
        publicKey: m.publicKey,
        hasWrap: m.wrappedOrgKey !== null,
      })),
    });
  });

  keys.post("/init", async (c) => {
    const r = resolve(c);
    if (!r.ok) return c.json(denialBody(r.status), r.status);
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    const wrappedOrgKey = asString(body.wrappedOrgKey);
    if (!wrappedOrgKey) {
      return c.json({ error: "wrappedOrgKey is required" }, 400);
    }
    const recoveryPublicKey = asString(body.recoveryPublicKey);
    const wrappedRecoveryKey = asString(body.wrappedRecoveryKey);

    // CAS inside one transaction: re-read under the write lock so two
    // founding members racing init cannot both seed a key.
    const initialized = r.db.transaction(() => {
      const state = readOrgState(r.db, r.identity.orgId);
      if (
        !state ||
        state.org.keyGeneration !== null ||
        anyWrapped(state.members)
      ) {
        return false;
      }
      r.db
        .query("UPDATE member SET wrappedOrgKey = ? WHERE id = ?")
        .run(wrappedOrgKey, r.self.memberId);
      if (recoveryPublicKey && wrappedRecoveryKey) {
        r.db
          .query(
            "UPDATE organization SET keyGeneration = 1, recoveryPublicKey = ?, wrappedRecoveryKey = ? WHERE id = ?",
          )
          .run(recoveryPublicKey, wrappedRecoveryKey, r.identity.orgId);
      } else {
        // Recovery fields set at org creation (or absent) stay untouched.
        r.db
          .query("UPDATE organization SET keyGeneration = 1 WHERE id = ?")
          .run(r.identity.orgId);
      }
      return true;
    })();
    if (!initialized) {
      log.warn({ orgId: r.identity.orgId }, "keys: init raced or repeated");
      return c.json(CONFLICT, 409);
    }
    log.info({ orgId: r.identity.orgId }, "keys: org key initialized (gen 1)");
    return c.json({ ok: true, keyGeneration: 1 });
  });

  keys.post("/wrap", async (c) => {
    const r = resolve(c);
    if (!r.ok) return c.json(denialBody(r.status), r.status);
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    const memberId = asString(body.memberId);
    const wrappedOrgKey = asString(body.wrappedOrgKey);
    if (!memberId || !wrappedOrgKey) {
      return c.json({ error: "memberId and wrappedOrgKey are required" }, 400);
    }
    const target = r.members.find((m) => m.memberId === memberId);
    if (!target) {
      log.warn(
        { orgId: r.identity.orgId, memberId },
        "keys: wrap target not in org",
      );
      return c.json(NOT_FOUND, 404);
    }
    // Only keyed members distribute wraps — except to THEMSELVES, the
    // recovery re-entry path (a wrap-less member writing garbage to their
    // own row hurts nobody else).
    const selfTarget = target.memberId === r.self.memberId;
    if (!selfTarget && r.self.wrappedOrgKey === null) {
      log.warn(
        { orgId: r.identity.orgId, memberId },
        "keys: wrap-less caller tried to wrap another member",
      );
      return c.json(FORBIDDEN, 403);
    }
    const updated = r.db.transaction(() => {
      const fresh = r.db
        .query("SELECT wrappedOrgKey FROM member WHERE id = ?")
        .get(memberId) as { wrappedOrgKey: string | null } | null;
      // Overwrites happen only via rotation — a keyed member's wrap is
      // never silently replaced. Self-target (recovery) may overwrite its
      // own row: the old wrap is unreadable to its owner by definition.
      if (!fresh || (fresh.wrappedOrgKey !== null && !selfTarget)) {
        return false;
      }
      r.db
        .query("UPDATE member SET wrappedOrgKey = ? WHERE id = ?")
        .run(wrappedOrgKey, memberId);
      return true;
    })();
    if (!updated) {
      log.warn(
        { orgId: r.identity.orgId, memberId },
        "keys: wrap target already keyed",
      );
      return c.json(CONFLICT, 409);
    }
    log.info({ orgId: r.identity.orgId, memberId }, "keys: wrap delivered");
    return c.json({ ok: true });
  });

  keys.post("/rotate", async (c) => {
    const r = resolve(c);
    if (!r.ok) return c.json(denialBody(r.status), r.status);
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    if (r.self.wrappedOrgKey === null) {
      log.warn(
        { orgId: r.identity.orgId },
        "keys: wrap-less caller tried to rotate",
      );
      return c.json(FORBIDDEN, 403);
    }
    const generation =
      typeof body.keyGeneration === "number" ? body.keyGeneration : null;
    const rawWraps = Array.isArray(body.wraps) ? body.wraps : null;
    if (generation === null || !rawWraps || rawWraps.length === 0) {
      return c.json(
        { error: "keyGeneration and a non-empty wraps array are required" },
        400,
      );
    }
    const wraps: Array<{ memberId: string; wrappedOrgKey: string }> = [];
    for (const entry of rawWraps) {
      if (typeof entry !== "object" || entry === null) {
        return c.json({ error: "malformed wraps entry" }, 400);
      }
      const record = entry as Record<string, unknown>;
      const memberId = asString(record.memberId);
      const wrappedOrgKey = asString(record.wrappedOrgKey);
      if (!memberId || !wrappedOrgKey) {
        return c.json({ error: "malformed wraps entry" }, 400);
      }
      wraps.push({ memberId, wrappedOrgKey });
    }
    const memberIds = new Set(r.members.map((m) => m.memberId));
    const distinct = new Set(wraps.map((w) => w.memberId));
    if (distinct.size !== wraps.length) {
      return c.json({ error: "duplicate memberId in wraps" }, 400);
    }
    for (const wrap of wraps) {
      if (!memberIds.has(wrap.memberId)) {
        log.warn(
          { orgId: r.identity.orgId, memberId: wrap.memberId },
          "keys: rotate wrap targets a non-member",
        );
        return c.json({ error: "wraps must target org members" }, 400);
      }
    }
    const recovery =
      typeof body.recovery === "object" && body.recovery !== null
        ? (body.recovery as Record<string, unknown>)
        : null;

    const rotated = r.db.transaction(() => {
      const fresh = r.db
        .query("SELECT keyGeneration FROM organization WHERE id = ?")
        .get(r.identity.orgId) as { keyGeneration: number | null } | null;
      const current = fresh?.keyGeneration ?? 0;
      // Stale-generation CAS: two racing rotations cannot both land.
      if (generation !== current + 1) return false;
      // Revocation teeth: every member NOT re-wrapped loses access.
      r.db
        .query(
          "UPDATE member SET wrappedOrgKey = NULL WHERE organizationId = ?",
        )
        .run(r.identity.orgId);
      for (const wrap of wraps) {
        r.db
          .query("UPDATE member SET wrappedOrgKey = ? WHERE id = ?")
          .run(wrap.wrappedOrgKey, wrap.memberId);
      }
      if (recovery) {
        r.db
          .query(
            "UPDATE organization SET keyGeneration = ?, recoveryPublicKey = ?, wrappedRecoveryKey = ? WHERE id = ?",
          )
          .run(
            generation,
            asString(recovery.recoveryPublicKey) ?? null,
            asString(recovery.wrappedRecoveryKey) ?? null,
            r.identity.orgId,
          );
      } else {
        r.db
          .query("UPDATE organization SET keyGeneration = ? WHERE id = ?")
          .run(generation, r.identity.orgId);
      }
      return true;
    })();
    if (!rotated) {
      log.warn(
        { orgId: r.identity.orgId, generation },
        "keys: rotate generation stale",
      );
      return c.json(CONFLICT, 409);
    }
    log.info(
      { orgId: r.identity.orgId, generation, wraps: wraps.length },
      "keys: org key rotated",
    );
    return c.json({ ok: true, keyGeneration: generation });
  });

  keys.post("/recovery", async (c) => {
    const r = resolve(c);
    if (!r.ok) return c.json(denialBody(r.status), r.status);
    // Recovery configuration is key management — keyed members only.
    if (r.self.wrappedOrgKey === null) {
      log.warn(
        { orgId: r.identity.orgId },
        "keys: wrap-less caller tried to configure recovery",
      );
      return c.json(FORBIDDEN, 403);
    }
    const [parseErr, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseErr) return c.json({ error: "Invalid JSON" }, 400);
    const recoveryPublicKey = asString(body.recoveryPublicKey);
    const wrappedRecoveryKey = asString(body.wrappedRecoveryKey);
    if (!recoveryPublicKey || !wrappedRecoveryKey) {
      return c.json(
        { error: "recoveryPublicKey and wrappedRecoveryKey are required" },
        400,
      );
    }
    r.db
      .query(
        "UPDATE organization SET recoveryPublicKey = ?, wrappedRecoveryKey = ? WHERE id = ?",
      )
      .run(recoveryPublicKey, wrappedRecoveryKey, r.identity.orgId);
    log.info({ orgId: r.identity.orgId }, "keys: recovery keyset configured");
    return c.json({ ok: true });
  });

  return keys;
}

export const keys = createKeysRoutes();
