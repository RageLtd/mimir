/**
 * MIM-88 blind sync routes: LWW matrix, org isolation, cursor semantics,
 * tombstone GC gating, payload opacity, lease coordination. In-memory
 * tenant db + stubbed identity + injected member count — no config
 * singleton, no auth store.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createTenantDb } from "../db/tenant";
import type { IdentityEnv } from "../middleware/identity";
import { createSyncRoutes } from "./sync";

type Identity = { userId: string; orgId: string };

const world = (memberCount = 1) => {
  const db = createTenantDb(":memory:");
  const appFor = (identity: Identity | null) => {
    const app = new Hono<IdentityEnv>();
    if (identity) {
      app.use("*", (c, next) => {
        c.set("identity", identity);
        return next();
      });
    }
    app.route(
      "/v1/sync",
      createSyncRoutes(
        () => db,
        () => memberCount,
      ),
    );
    return app;
  };
  return { db, appFor };
};

const envelope = (
  id: string,
  version = 1,
  overrides?: Record<string, unknown>,
) => ({
  id,
  kind: 1,
  v: 2,
  suite: 1,
  keyGen: 1,
  version,
  tombstone: false,
  nonce: "AAECAwQFBgcICQoL",
  payload: "AAECAwQFBgcICQoLDA0ODw",
  ...overrides,
});

const push = (app: Hono<IdentityEnv>, envelopes: unknown[]) =>
  app.request("/v1/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelopes }),
  });

const pull = async (app: Hono<IdentityEnv>, since = 0) => {
  const res = await app.request(`/v1/sync/pull?since=${since}`);
  return (await res.json()) as {
    orgId: string;
    envelopes: Array<Record<string, unknown>>;
    nextCursor: number;
  };
};

const json = async (res: Response) =>
  (await res.json()) as Record<string, unknown>;

const A: Identity = { userId: "user-a", orgId: "org-1" };
const B: Identity = { userId: "user-b", orgId: "org-1" };
const OUTSIDER: Identity = { userId: "user-x", orgId: "org-2" };

describe("push/pull round-trip", () => {
  test("envelopes come back verbatim in seq order", async () => {
    const { appFor } = world();
    const app = appFor(A);
    const first = await json(await push(app, [envelope("memory:one")]));
    expect(first.accepted).toBe(1);
    await push(app, [
      envelope("memory:two", 1, { suite: 0, keyGen: 0, nonce: "" }),
    ]);

    const pulled = await pull(app);
    expect(pulled.orgId).toBe("org-1");
    expect(pulled.envelopes.map((e) => e.id)).toEqual([
      "memory:one",
      "memory:two",
    ]);
    // Verbatim: every field survives, payload untouched.
    expect(pulled.envelopes[0]?.payload).toBe("AAECAwQFBgcICQoLDA0ODw");
    expect(pulled.envelopes[1]?.suite).toBe(0);
    expect(pulled.nextCursor).toBeGreaterThan(0);
  });

  test("pull since cursor returns only newer envelopes", async () => {
    const { appFor } = world();
    const app = appFor(A);
    await push(app, [envelope("memory:old")]);
    const { nextCursor } = await pull(app);
    await push(app, [envelope("memory:new")]);
    const delta = await pull(app, nextCursor);
    expect(delta.envelopes.map((e) => e.id)).toEqual(["memory:new"]);
  });

  test("payload is opaque but must stay within the wire encoding contract", async () => {
    const { appFor } = world();
    const app = appFor(A);
    const res = await push(app, [
      envelope("memory:garbage", 1, { payload: "!!!not-even-base64url!!!" }),
    ]);
    expect(res.status).toBe(400);
  });
});

describe("LWW", () => {
  test("higher version replaces; lower is reported stale", async () => {
    const { appFor } = world();
    const app = appFor(A);
    await push(app, [envelope("memory:contested", 2)]);
    const older = await json(
      await push(app, [envelope("memory:contested", 1)]),
    );
    expect(older.accepted).toBe(0);
    expect(older.stale).toEqual(["memory:contested"]);
    const newer = await json(
      await push(app, [envelope("memory:contested", 3)]),
    );
    expect(newer.accepted).toBe(1);
    const pulled = await pull(app);
    expect(pulled.envelopes).toHaveLength(1);
    expect(pulled.envelopes[0]?.version).toBe(3);
  });

  test("equal version is rejected instead of replacing authenticated history", async () => {
    const { appFor } = world();
    const app = appFor(A);
    await push(app, [
      envelope("memory:tie", 2, { payload: "Zmlyc3QtY2lwaGVydGV4dA" }),
    ]);
    const second = await json(
      await push(appFor(B), [
        envelope("memory:tie", 2, {
          payload: "c2Vjb25kLWNpcGhlcnRleHQ",
        }),
      ]),
    );
    expect(second.accepted).toBe(0);
    expect(second.stale).toEqual(["memory:tie"]);
    const pulled = await pull(app);
    expect(pulled.envelopes[0]?.payload).toBe("Zmlyc3QtY2lwaGVydGV4dA");
  });

  test("replacement gets a fresh seq so laggards see the update", async () => {
    const { appFor } = world();
    const app = appFor(A);
    await push(app, [envelope("memory:evolving", 1)]);
    const { nextCursor } = await pull(app);
    await push(app, [envelope("memory:evolving", 2)]);
    const delta = await pull(app, nextCursor);
    expect(delta.envelopes.map((e) => e.id)).toEqual(["memory:evolving"]);
    expect(delta.envelopes[0]?.version).toBe(2);
  });

  test("an older client cannot downgrade an authenticated v2 record", async () => {
    const { appFor } = world();
    const app = appFor(A);
    await push(app, [envelope("memory:secure", 2)]);
    const downgrade = await json(
      await push(app, [envelope("memory:secure", 3, { v: 1 })]),
    );
    expect(downgrade.accepted).toBe(0);
    expect(downgrade.stale).toEqual(["memory:secure"]);
    expect((await pull(app)).envelopes[0]?.v).toBe(2);
  });
});

describe("org isolation", () => {
  test("no bleed between orgs on pull or push", async () => {
    const { appFor } = world();
    await push(appFor(A), [envelope("memory:org1-secret")]);
    await push(appFor(OUTSIDER), [envelope("memory:org2-thing")]);
    const org2 = await pull(appFor(OUTSIDER));
    expect(org2.envelopes.map((e) => e.id)).toEqual(["memory:org2-thing"]);
    const org1 = await pull(appFor(A));
    expect(org1.envelopes.map((e) => e.id)).toEqual(["memory:org1-secret"]);
  });
});

describe("auth-off (self-hosted) mode", () => {
  test("no identity → owner sentinel scope, single local user", async () => {
    const { appFor } = world();
    const app = appFor(null);
    await push(app, [
      envelope("memory:selfhosted", 1, {
        suite: 0,
        keyGen: 0,
        nonce: "",
      }),
    ]);
    const pulled = await pull(app);
    expect(pulled.orgId).toBe("owner");
    expect(pulled.envelopes).toHaveLength(1);
  });
});

describe("tombstone GC", () => {
  test("GC waits for every member's cursor to pass the tombstone", async () => {
    const { db, appFor } = world(2); // two members in org-1
    const appA = appFor(A);
    const appB = appFor(B);
    await push(appA, [envelope("memory:doomed", 1)]);
    await push(appA, [envelope("memory:doomed", 2, { tombstone: true })]);

    // Only A has pulled past the tombstone; B lags at 0 → no GC.
    const a = await pull(appA);
    await pull(appA, a.nextCursor); // records A's confirmed cursor
    await push(appA, [envelope("memory:unrelated")]); // triggers GC pass
    const rows = () =>
      db
        .query("SELECT COUNT(*) AS n FROM envelope WHERE tombstone = 1")
        .get() as {
        n: number;
      };
    expect(rows().n).toBe(1);

    // B catches up and confirms; the next push GCs the tombstone.
    const b = await pull(appB);
    await pull(appB, b.nextCursor);
    await push(appA, [envelope("memory:another")]);
    expect(rows().n).toBe(0);
  });
});

describe("validation", () => {
  test("malformed envelopes are rejected wholesale", async () => {
    const { appFor } = world();
    const res = await push(appFor(A), [{ id: "memory:x" }]);
    expect(res.status).toBe(400);
  });

  test("bad since/limit rejected", async () => {
    const { appFor } = world();
    const res = await appFor(A).request("/v1/sync/pull?since=-3");
    expect(res.status).toBe(400);
  });
});

describe("leases (blind coordination)", () => {
  const lease = (app: Hono<IdentityEnv>, name: string, ttlSeconds = 60) =>
    app.request("/v1/sync/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ttlSeconds }),
    });

  test("acquire, contend, release, re-acquire", async () => {
    const { appFor } = world(2);
    const appA = appFor(A);
    const appB = appFor(B);
    expect((await lease(appA, "hygiene")).status).toBe(200);
    // B cannot steal a live lease…
    expect((await lease(appB, "hygiene")).status).toBe(409);
    // …but the holder re-acquires (extends) freely.
    expect((await lease(appA, "hygiene")).status).toBe(200);
    // Release, then B acquires.
    const release = await appA.request("/v1/sync/lease", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hygiene" }),
    });
    expect(release.status).toBe(200);
    expect((await lease(appB, "hygiene")).status).toBe(200);
  });

  test("expired leases are stealable", async () => {
    const { db, appFor } = world(2);
    await lease(appFor(A), "sweep", 60);
    // Age the lease out manually.
    db.query("UPDATE lease SET expires_at = ? WHERE name = 'sweep'").run(
      Date.now() - 1000,
    );
    expect((await lease(appFor(B), "sweep")).status).toBe(200);
  });

  test("leases are org-scoped", async () => {
    const { appFor } = world();
    await lease(appFor(A), "hygiene");
    // Same name, different org — no contention.
    expect((await lease(appFor(OUTSIDER), "hygiene")).status).toBe(200);
  });
});
