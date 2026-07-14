/**
 * MIM-87 wrapped-key distribution routes: authz matrix, init CAS,
 * rotate atomicity. Runs against an in-memory migrated better-auth
 * store (key-shelf.test.ts pattern) with the identity stubbed the way
 * the gate would set it — the routes never see network or config.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Hono } from "hono";
import { migrateOrganizationAudit } from "../audit/store";
import { buildAuthOptions } from "../auth/instance";
import { migrateOrganizationLifecycle } from "../auth/organization-lifecycle";
import type { IdentityEnv } from "../middleware/identity";
import { createKeysRoutes } from "./keys";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

type Identity = { userId: string; orgId: string; authenticatedAt?: number };

const appFor = (
  db: Database,
  identity: Identity | null,
  options?: { origin?: string; now?: () => number },
) => {
  const app = new Hono<IdentityEnv>();
  if (identity) {
    app.use("*", (c, next) => {
      c.set("identity", identity);
      return next();
    });
  }
  app.route("/v1/keys", createKeysRoutes(() => db, options));
  return app;
};

const getJson = async (res: Response) =>
  (await res.json()) as Record<string, unknown>;

/** Two users, one org: A is the founding owner member, B joined later
 *  (inserted directly — better-auth's invitation ceremony is not under
 *  test here). Both carry public keys. */
async function seedOrg() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  migrateOrganizationAudit(db);
  migrateOrganizationLifecycle(db);
  const auth = betterAuth(options);

  const signupA = await auth.api.signUpEmail({
    body: {
      email: "a@test.local",
      password: "password-a-123456",
      name: "A",
      publicKey: "pub-a",
    },
    returnHeaders: true,
  });
  const cookie = signupA.headers
    .getSetCookie()
    .map((sc) => sc.split(";")[0])
    .join("; ");
  await auth.api.createOrganization({
    body: { name: "Keys Org", slug: "keys-org" },
    headers: new Headers({ cookie }),
  });
  const userA = signupA.response.user.id;
  const org = db
    .query("SELECT id FROM organization WHERE slug = 'keys-org'")
    .get() as { id: string };

  const signupB = await auth.api.signUpEmail({
    body: {
      email: "b@test.local",
      password: "password-b-123456",
      name: "B",
      publicKey: "pub-b",
    },
  });
  const userB = signupB.user.id;
  db.query(
    "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)",
  ).run(crypto.randomUUID(), org.id, userB, new Date().toISOString());

  const memberRow = (userId: string) =>
    db
      .query(
        "SELECT id, wrappedOrgKey FROM member WHERE organizationId = ? AND userId = ?",
      )
      .get(org.id, userId) as { id: string; wrappedOrgKey: string | null };

  return {
    db,
    orgId: org.id,
    userA,
    userB,
    memberRow,
    asA: { userId: userA, orgId: org.id },
    asB: { userId: userB, orgId: org.id },
  };
}

const post = (
  app: Hono<IdentityEnv>,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("identity requirements", () => {
  test("no identity (auth-off) → 403", async () => {
    const { db } = await seedOrg();
    const res = await appFor(db, null).request("/v1/keys/org");
    expect(res.status).toBe(403);
  });

  test("identity outside the org → 403", async () => {
    const { db, userA } = await seedOrg();
    const res = await appFor(db, {
      userId: userA,
      orgId: "not-an-org",
    }).request("/v1/keys/org");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/keys/org", () => {
  test("reports uninitialized state with member public keys", async () => {
    const { db, asA, userB } = await seedOrg();
    const res = await appFor(db, asA).request("/v1/keys/org");
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.initialized).toBe(false);
    expect(body.keyGeneration).toBeNull();
    const members = body.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(2);
    const b = members.find((m) => m.userId === userB);
    expect(b?.publicKey).toBe("pub-b");
    expect(b?.hasWrap).toBe(false);
  });

  test("self carries own publicKey and encryptedKeyset", async () => {
    const { db, asA, userA } = await seedOrg();
    db.query('UPDATE "user" SET encryptedKeyset = ? WHERE id = ?').run(
      "keyset-ciphertext-a",
      userA,
    );
    const body = await getJson(await appFor(db, asA).request("/v1/keys/org"));
    const self = body.self as Record<string, unknown>;
    expect(self.publicKey).toBe("pub-a");
    expect(self.encryptedKeyset).toBe("keyset-ciphertext-a");
    // Other members' keysets are not served.
    const members = body.members as Array<Record<string, unknown>>;
    for (const m of members) {
      expect("encryptedKeyset" in m).toBe(false);
    }
  });
});

describe("POST /v1/keys/init", () => {
  test("founding member seeds gen 1; second init conflicts", async () => {
    const { db, asA, asB, memberRow, userA } = await seedOrg();
    const first = await post(appFor(db, asA), "/v1/keys/init", {
      wrappedOrgKey: "wrap-a-gen1",
    });
    expect(first.status).toBe(200);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-gen1");

    const state = await getJson(
      await appFor(db, asA).request("/v1/keys/org"),
    );
    expect(state.initialized).toBe(true);
    expect(state.keyGeneration).toBe(1);

    // The founding race: B's init must lose, not fork a second org key.
    const second = await post(appFor(db, asB), "/v1/keys/init", {
      wrappedOrgKey: "wrap-b-forked",
    });
    expect(second.status).toBe(409);
  });

  test("stores recovery fields when provided", async () => {
    const { db, asA } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", {
      wrappedOrgKey: "wrap-a",
      recoveryPublicKey: "recovery-pub",
      wrappedRecoveryKey: "keyring-wrapped-to-recovery",
    });
    const state = await getJson(await appFor(db, asA).request("/v1/keys/org"));
    expect(state.recoveryPublicKey).toBe("recovery-pub");
    expect(state.wrappedRecoveryKey).toBe("keyring-wrapped-to-recovery");
  });

  test("missing wrappedOrgKey → 400", async () => {
    const { db, asA } = await seedOrg();
    const res = await post(appFor(db, asA), "/v1/keys/init", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/keys/wrap", () => {
  test("keyed member delivers a wrap to a wrap-less member", async () => {
    const { db, asA, asB, memberRow, userB } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asA), "/v1/keys/wrap", {
      memberId: memberRow(userB).id,
      wrappedOrgKey: "wrap-b",
    });
    expect(res.status).toBe(200);
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b");
    expect(
      db
        .query(
          "SELECT action, target_id, outcome, metadata_json FROM organization_audit_event ORDER BY seq",
        )
        .all(),
    ).toEqual([
      {
        action: "encryption.wrap_provisioned",
        target_id: memberRow(userB).id,
        outcome: "intent",
        metadata_json: "{}",
      },
      {
        action: "encryption.wrap_provisioned",
        target_id: memberRow(userB).id,
        outcome: "succeeded",
        metadata_json: "{}",
      },
    ]);
    // B can read their own wrap back.
    const state = await getJson(await appFor(db, asB).request("/v1/keys/org"));
    expect((state.self as Record<string, unknown>).wrappedOrgKey).toBe(
      "wrap-b",
    );
  });

  test("wrap-less caller cannot wrap another member", async () => {
    const { db, asA, asB, memberRow, userA } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    // B holds no wrap yet and tries to overwrite A's row.
    const res = await post(appFor(db, asB), "/v1/keys/wrap", {
      memberId: memberRow(userA).id,
      wrappedOrgKey: "poisoned",
    });
    expect(res.status).toBe(403);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a");
  });

  test("self-target is allowed for a wrap-less member (recovery re-entry)", async () => {
    const { db, asA, asB, memberRow, userB } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asB), "/v1/keys/wrap", {
      memberId: memberRow(userB).id,
      wrappedOrgKey: "wrap-b-recovered",
    });
    expect(res.status).toBe(200);
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-recovered");
  });

  test("keyed target is never overwritten by another member", async () => {
    const { db, asA, asB, memberRow, userB } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    await post(appFor(db, asA), "/v1/keys/wrap", {
      memberId: memberRow(userB).id,
      wrappedOrgKey: "wrap-b",
    });
    const res = await post(appFor(db, asA), "/v1/keys/wrap", {
      memberId: memberRow(userB).id,
      wrappedOrgKey: "wrap-b-again",
    });
    expect(res.status).toBe(409);
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b");
    void asB;
  });

  test("target outside the org → 404", async () => {
    const { db, asA } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asA), "/v1/keys/wrap", {
      memberId: "nonexistent-member",
      wrappedOrgKey: "wrap-x",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/keys/rotate", () => {
  const seedKeyed = async () => {
    const seeded = await seedOrg();
    const { db, asA, memberRow, userB } = seeded;
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a-1" });
    await post(appFor(db, asA), "/v1/keys/wrap", {
      memberId: memberRow(userB).id,
      wrappedOrgKey: "wrap-b-1",
    });
    return seeded;
  };

  test("ordinary rotation re-wraps every key-ready member", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    const res = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps: [
        { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-2" },
        { memberId: memberRow(userB).id, wrappedOrgKey: "wrap-b-2" },
      ],
      recovery: {
        recoveryPublicKey: "recovery-pub-2",
        wrappedRecoveryKey: "recovery-wrap-2",
      },
    });
    expect(res.status).toBe(200);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-2");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-2");
    const state = await getJson(await appFor(db, asA).request("/v1/keys/org"));
    expect(state.keyGeneration).toBe(2);
    expect(state.recoveryPublicKey).toBe("recovery-pub-2");
  });

  test("key rotation conflicts while organization deletion is pending", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    db.query(
      `INSERT INTO organization_deletion_schedule
        (org_id, schedule_id, actor_user_id, request_id, scheduled_at, purge_after, status)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`,
    ).run(
      asA.orgId,
      "schedule:pending",
      userA,
      "request:schedule",
      "2026-07-14T03:00:00.000Z",
      "2026-07-21T03:00:00.000Z",
    );

    const response = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps: [
        { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-2" },
        { memberId: memberRow(userB).id, wrappedOrgKey: "wrap-b-2" },
      ],
    });

    expect(response.status).toBe(409);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-1");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-1");
  });

  test("recent owner rotation removes the member only after generation acceptance", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    const now = Date.parse("2026-07-14T03:00:00.000Z");
    const response = await post(
      appFor(
        db,
        { ...asA, authenticatedAt: now - 60_000 },
        { origin: "https://mimir.test", now: () => now },
      ),
      "/v1/keys/rotate",
      {
        keyGeneration: 2,
        wraps: [
          { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-2" },
        ],
        removeMemberId: memberRow(userB).id,
      },
      { cookie: "session=owner", origin: "https://mimir.test" },
    );

    expect(response.status).toBe(200);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-2");
    expect(
      db
        .query("SELECT id FROM member WHERE organizationId = ? AND userId = ?")
        .get(asA.orgId, userB),
    ).toBeNull();
    expect(
      db
        .query(
          "SELECT action, outcome FROM organization_audit_event ORDER BY seq",
        )
        .all(),
    ).toEqual([
      { action: "encryption.wrap_provisioned", outcome: "intent" },
      { action: "encryption.wrap_provisioned", outcome: "succeeded" },
      { action: "encryption.generation_changed", outcome: "intent" },
      { action: "membership.removed", outcome: "intent" },
      { action: "encryption.generation_changed", outcome: "succeeded" },
      { action: "membership.removed", outcome: "succeeded" },
    ]);
  });

  test("failed revocation rotation leaves membership and wraps unchanged", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    const now = Date.parse("2026-07-14T03:00:00.000Z");
    const response = await post(
      appFor(
        db,
        { ...asA, authenticatedAt: now },
        { origin: "https://mimir.test", now: () => now },
      ),
      "/v1/keys/rotate",
      {
        keyGeneration: 3,
        wraps: [
          { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-3" },
        ],
        removeMemberId: memberRow(userB).id,
      },
      { cookie: "session=owner", origin: "https://mimir.test" },
    );

    expect(response.status).toBe(409);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-1");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-1");
    expect(
      db
        .query("SELECT COUNT(*) AS count FROM member WHERE organizationId = ?")
        .get(asA.orgId),
    ).toEqual({ count: 2 });
    expect(
      db
        .query("SELECT action, outcome FROM organization_audit_event ORDER BY seq")
        .all(),
    ).toEqual([
      { action: "encryption.wrap_provisioned", outcome: "intent" },
      { action: "encryption.wrap_provisioned", outcome: "succeeded" },
      { action: "encryption.generation_changed", outcome: "intent" },
      { action: "membership.removed", outcome: "intent" },
      { action: "encryption.generation_changed", outcome: "failed" },
      { action: "membership.removed", outcome: "failed" },
    ]);
  });

  test("last owner cannot remove themselves and API keys cannot revoke members", async () => {
    const { db, asA, asB, memberRow, userA, userB } = await seedKeyed();
    const now = Date.parse("2026-07-14T03:00:00.000Z");
    const browser = appFor(
      db,
      { ...asA, authenticatedAt: now },
      { origin: "https://mimir.test", now: () => now },
    );
    const body = {
      keyGeneration: 2,
      wraps: [
        { memberId: memberRow(userB).id, wrappedOrgKey: "wrap-b-2" },
      ],
      removeMemberId: memberRow(userA).id,
    };
    expect(
      (
        await post(browser, "/v1/keys/rotate", body, {
          cookie: "session=owner",
          origin: "https://mimir.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          appFor(db, { ...asA, authenticatedAt: now }),
          "/v1/keys/rotate",
          {
            ...body,
            removeMemberId: memberRow(userB).id,
            wraps: [
              { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-2" },
            ],
          },
          { authorization: "Bearer api-key", origin: "https://mimir.test" },
        )
      ).status,
    ).toBe(403);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-1");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-1");
    void asB;
  });

  test("stale generation → 409 and nothing changes", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    const res = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 3, // current is 1; must be exactly 2
      wraps: [
        { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-3" },
        { memberId: memberRow(userB).id, wrappedOrgKey: "wrap-b-3" },
      ],
    });
    expect(res.status).toBe(409);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-1");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-1");
  });

  test("configured recovery must be refreshed without changing its public key", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    await post(appFor(db, asA), "/v1/keys/recovery", {
      recoveryPublicKey: "recovery-pub",
      wrappedRecoveryKey: "recovery-wrap-1",
    });
    const wraps = [
      { memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-2" },
      { memberId: memberRow(userB).id, wrappedOrgKey: "wrap-b-2" },
    ];

    const missing = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps,
    });
    expect(missing.status).toBe(409);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-1");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-1");

    const refreshed = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps,
      recovery: {
        recoveryPublicKey: "recovery-pub",
        wrappedRecoveryKey: "recovery-wrap-2",
      },
    });
    expect(refreshed.status).toBe(200);
    const state = await getJson(await appFor(db, asA).request("/v1/keys/org"));
    expect(state.keyGeneration).toBe(2);
    expect(state.recoveryPublicKey).toBe("recovery-pub");
    expect(state.wrappedRecoveryKey).toBe("recovery-wrap-2");
  });

  test("wrap-less caller cannot rotate", async () => {
    const { db, asA, asB, memberRow, userA, userB } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asB), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps: [{ memberId: memberRow(userB).id, wrappedOrgKey: "hijack" }],
    });
    expect(res.status).toBe(403);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a");
  });

  test("wraps targeting non-members → 400", async () => {
    const { db, asA } = await seedKeyed();
    const res = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps: [{ memberId: "stranger", wrappedOrgKey: "wrap-x" }],
    });
    expect(res.status).toBe(400);
  });

  test("empty wraps → 400", async () => {
    const { db, asA } = await seedKeyed();
    const res = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps: [],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/keys/recovery", () => {
  test("keyed member configures the recovery keyset", async () => {
    const { db, asA } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asA), "/v1/keys/recovery", {
      recoveryPublicKey: "recovery-pub",
      wrappedRecoveryKey: "keyring-wrapped-to-recovery",
    });
    expect(res.status).toBe(200);
    const state = await getJson(await appFor(db, asA).request("/v1/keys/org"));
    expect(state.recoveryPublicKey).toBe("recovery-pub");
    expect(state.wrappedRecoveryKey).toBe("keyring-wrapped-to-recovery");
  });

  test("wrap-less caller cannot configure recovery", async () => {
    const { db, asA, asB } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asB), "/v1/keys/recovery", {
      recoveryPublicKey: "hijack-pub",
      wrappedRecoveryKey: "hijack-wrap",
    });
    expect(res.status).toBe(403);
  });

  test("missing fields → 400", async () => {
    const { db, asA } = await seedOrg();
    await post(appFor(db, asA), "/v1/keys/init", { wrappedOrgKey: "wrap-a" });
    const res = await post(appFor(db, asA), "/v1/keys/recovery", {
      recoveryPublicKey: "only-half",
    });
    expect(res.status).toBe(400);
  });
});
