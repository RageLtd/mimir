import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { migrateOrganizationAudit } from "../audit/store";
import { migrateOrganizationLifecycle } from "../auth/organization-lifecycle";
import type { IdentityEnv } from "../middleware/identity";
import { createMembersRoutes } from "./members";

const NOW = Date.parse("2026-07-14T03:00:00.000Z");
const ORIGIN = "https://mimir.test";

function membershipDb() {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE "user" (
      id TEXT PRIMARY KEY,
      publicKey TEXT
    ) STRICT`,
  );
  db.run(
    `CREATE TABLE organization (
      id TEXT PRIMARY KEY,
      keyGeneration INTEGER,
      recoveryPublicKey TEXT,
      wrappedRecoveryKey TEXT
    ) STRICT`,
  );
  db.run(
    `CREATE TABLE member (
      id TEXT PRIMARY KEY,
      organizationId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL,
      wrappedOrgKey TEXT
    ) STRICT`,
  );
  db.run(
    `INSERT INTO "user" (id, publicKey) VALUES
      ('user-owner', 'public-owner'),
      ('user-admin', 'public-admin'),
      ('user-member', 'public-member')`,
  );
  db.run("INSERT INTO organization (id, keyGeneration) VALUES ('org-1', 1)");
  db.run(
    `INSERT INTO member (id, organizationId, userId, role, wrappedOrgKey) VALUES
      ('member-owner', 'org-1', 'user-owner', 'owner', 'wrap-owner'),
      ('member-admin', 'org-1', 'user-admin', 'admin', 'wrap-admin'),
      ('member-member', 'org-1', 'user-member', 'member', 'wrap-member')`,
  );
  migrateOrganizationAudit(db);
  migrateOrganizationLifecycle(db);
  return db;
}

function appFor(db: Database, userId: string, authenticatedAt = NOW) {
  const app = new Hono<IdentityEnv>();
  app.use("*", (c, next) => {
    c.set("identity", { userId, orgId: "org-1", authenticatedAt });
    return next();
  });
  app.route(
    "/v1/members",
    createMembersRoutes(() => db, { origin: ORIGIN, now: () => NOW }),
  );
  return app;
}

const changeRole = (
  app: Hono<IdentityEnv>,
  memberId: string,
  role: string,
  headers: Record<string, string> = {},
) =>
  app.request("/v1/members/role", {
    method: "POST",
    headers: {
      cookie: "session=browser",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ memberId, role }),
  });

const roleOf = (db: Database, memberId: string) =>
  db
    .query<{ role: string }, [string]>("SELECT role FROM member WHERE id = ?")
    .get(memberId)?.role;

describe("POST /v1/members/role", () => {
  test("owner changes a role with bounded intent and success events", async () => {
    const db = membershipDb();
    const response = await changeRole(
      appFor(db, "user-owner"),
      "member-admin",
      "member",
    );

    expect(response.status).toBe(200);
    expect(roleOf(db, "member-admin")).toBe("member");
    expect(
      db
        .query(
          "SELECT action, target_id, outcome, metadata_json FROM organization_audit_event ORDER BY seq",
        )
        .all(),
    ).toEqual([
      {
        action: "membership.role_changed",
        target_id: "member-admin",
        outcome: "intent",
        metadata_json: '{"fromRole":"admin","toRole":"member"}',
      },
      {
        action: "membership.role_changed",
        target_id: "member-admin",
        outcome: "succeeded",
        metadata_json: '{"fromRole":"admin","toRole":"member"}',
      },
    ]);
  });

  test("admin cannot mutate an owner or assign the owner role", async () => {
    const db = membershipDb();
    const app = appFor(db, "user-admin");

    expect((await changeRole(app, "member-owner", "member")).status).toBe(403);
    expect((await changeRole(app, "member-member", "owner")).status).toBe(403);
    expect(roleOf(db, "member-owner")).toBe("owner");
    expect(roleOf(db, "member-member")).toBe("member");
    expect(
      db
        .query(
          "SELECT action, outcome FROM organization_audit_event ORDER BY seq",
        )
        .all(),
    ).toEqual([
      { action: "membership.role_changed", outcome: "intent" },
      { action: "organization.ownership_changed", outcome: "intent" },
      { action: "membership.role_changed", outcome: "failed" },
      { action: "organization.ownership_changed", outcome: "failed" },
      { action: "membership.role_changed", outcome: "intent" },
      { action: "organization.ownership_changed", outcome: "intent" },
      { action: "membership.role_changed", outcome: "failed" },
      { action: "organization.ownership_changed", outcome: "failed" },
    ]);
  });

  test("owner promotion requires current encryption-key access", async () => {
    const db = membershipDb();
    const app = appFor(db, "user-owner");
    db.query("UPDATE member SET wrappedOrgKey = NULL WHERE id = ?").run(
      "member-member",
    );

    expect((await changeRole(app, "member-member", "owner")).status).toBe(403);
    expect(roleOf(db, "member-member")).toBe("member");

    db.query("UPDATE member SET wrappedOrgKey = ? WHERE id = ?").run(
      "wrap-member",
      "member-member",
    );
    expect((await changeRole(app, "member-member", "owner")).status).toBe(200);
    expect(roleOf(db, "member-member")).toBe("owner");
    expect(
      db
        .query(
          `SELECT outcome FROM organization_audit_event
            WHERE action = 'organization.ownership_changed' ORDER BY seq`,
        )
        .all(),
    ).toEqual([
      { outcome: "intent" },
      { outcome: "failed" },
      { outcome: "intent" },
      { outcome: "succeeded" },
    ]);
  });

  test("ownership changes conflict while deletion is pending", async () => {
    const db = membershipDb();
    db.query(
      `INSERT INTO organization_deletion_schedule
        (org_id, schedule_id, actor_user_id, request_id, scheduled_at, purge_after, status)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`,
    ).run(
      "org-1",
      "schedule:pending",
      "user-owner",
      "request:schedule",
      "2026-07-14T03:00:00.000Z",
      "2026-07-21T03:00:00.000Z",
    );

    const response = await changeRole(
      appFor(db, "user-owner"),
      "member-admin",
      "owner",
    );

    expect(response.status).toBe(409);
    expect(roleOf(db, "member-admin")).toBe("admin");
  });

  test("the last owner cannot demote themselves", async () => {
    const db = membershipDb();
    const response = await changeRole(
      appFor(db, "user-owner"),
      "member-owner",
      "admin",
    );

    expect(response.status).toBe(403);
    expect(roleOf(db, "member-owner")).toBe("owner");
  });

  test("an owner can leave only after another owner has key access", async () => {
    const db = membershipDb();
    const app = appFor(db, "user-owner");
    db.query(
      "UPDATE member SET role = 'owner', wrappedOrgKey = NULL WHERE id = ?",
    ).run("member-admin");

    expect((await changeRole(app, "member-owner", "admin")).status).toBe(403);
    db.query("UPDATE member SET wrappedOrgKey = ? WHERE id = ?").run(
      "wrap-admin",
      "member-admin",
    );
    expect((await changeRole(app, "member-owner", "admin")).status).toBe(200);
    expect(roleOf(db, "member-owner")).toBe("admin");
  });

  test("requires a recent cookie session and exact trusted origin", async () => {
    const db = membershipDb();
    const old = appFor(db, "user-owner", NOW - 10 * 60 * 1000 - 1);
    const current = appFor(db, "user-owner");

    expect((await changeRole(old, "member-admin", "member")).status).toBe(403);
    expect(
      (
        await changeRole(current, "member-admin", "member", {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await changeRole(current, "member-admin", "member", {
          authorization: "Bearer api-key",
        })
      ).status,
    ).toBe(403);
    expect(roleOf(db, "member-admin")).toBe("admin");
  });
});
