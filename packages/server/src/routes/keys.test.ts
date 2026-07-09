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
import { buildAuthOptions } from "../auth/instance";
import type { IdentityEnv } from "../middleware/identity";
import { createKeysRoutes } from "./keys";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

type Identity = { userId: string; orgId: string };

const appFor = (db: Database, identity: Identity | null) => {
  const app = new Hono<IdentityEnv>();
  if (identity) {
    app.use("*", (c, next) => {
      c.set("identity", identity);
      return next();
    });
  }
  app.route("/v1/keys", createKeysRoutes(() => db));
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

const post = (app: Hono<IdentityEnv>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

  test("rotation replaces listed wraps and revokes unlisted members", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    const res = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 2,
      wraps: [{ memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-2" }],
      recovery: {
        recoveryPublicKey: "recovery-pub-2",
        wrappedRecoveryKey: "recovery-wrap-2",
      },
    });
    expect(res.status).toBe(200);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-2");
    // Revocation teeth: B was not re-wrapped, so B lost access.
    expect(memberRow(userB).wrappedOrgKey).toBeNull();
    const state = await getJson(await appFor(db, asA).request("/v1/keys/org"));
    expect(state.keyGeneration).toBe(2);
    expect(state.recoveryPublicKey).toBe("recovery-pub-2");
  });

  test("stale generation → 409 and nothing changes", async () => {
    const { db, asA, memberRow, userA, userB } = await seedKeyed();
    const res = await post(appFor(db, asA), "/v1/keys/rotate", {
      keyGeneration: 3, // current is 1; must be exactly 2
      wraps: [{ memberId: memberRow(userA).id, wrappedOrgKey: "wrap-a-3" }],
    });
    expect(res.status).toBe(409);
    expect(memberRow(userA).wrappedOrgKey).toBe("wrap-a-1");
    expect(memberRow(userB).wrappedOrgKey).toBe("wrap-b-1");
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
