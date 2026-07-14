import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import {
  createOrganizationAuditStore,
  migrateOrganizationAudit,
} from "../audit/store";
import { buildAuthOptions } from "./instance";
import { migrateOrganizationPolicy } from "./organization-policy";
import {
  readOrganizationSettings,
  updateOrganizationName,
  updateOrganizationPolicy,
  updateOrganizationSlug,
} from "./organization-settings";

function settingsDb() {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      keyGeneration INTEGER,
      recoveryPublicKey TEXT,
      wrappedRecoveryKey TEXT
    ) STRICT;
    CREATE TABLE member (
      id TEXT PRIMARY KEY,
      organizationId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL
    ) STRICT;
    INSERT INTO organization
      (id, name, slug, keyGeneration, recoveryPublicKey, wrappedRecoveryKey)
    VALUES
      ('org-a', 'First Org', 'first-org', 4, 'recovery-public', 'recovery-wrap'),
      ('org-b', 'Second Org', 'second-org', NULL, NULL, NULL);
    INSERT INTO member (id, organizationId, userId, role)
    VALUES
      ('member-owner', 'org-a', 'owner-user', 'owner'),
      ('member-admin', 'org-a', 'admin-user', 'admin'),
      ('member-other', 'org-b', 'owner-user', 'owner');
  `);
  migrateOrganizationAudit(db);
  migrateOrganizationPolicy(db);
  return db;
}

function updater(db: Database) {
  const calls: Array<{
    organizationId: string;
    data: { name?: string; slug?: string };
  }> = [];
  return {
    calls,
    update: async (input: {
      organizationId: string;
      data: { name?: string; slug?: string };
    }) => {
      calls.push(input);
      if (input.data.name) {
        db.query("UPDATE organization SET name = ? WHERE id = ?").run(
          input.data.name,
          input.organizationId,
        );
      }
      if (input.data.slug) {
        db.query("UPDATE organization SET slug = ? WHERE id = ?").run(
          input.data.slug,
          input.organizationId,
        );
      }
    },
  };
}

const headers = new Headers({ cookie: "better-auth.session_token=session" });
const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

describe("organization settings", () => {
  test("reads bounded active-organization settings and recovery readiness", () => {
    const db = settingsDb();

    expect(readOrganizationSettings(db, "org-a")).toEqual({
      id: "org-a",
      name: "First Org",
      slug: "first-org",
      defaultInvitationRole: "member",
      invitationLifetimeDays: 2,
      auditRetentionDays: 365,
      policyVersion: 0,
      keyGeneration: 4,
      recoveryReady: true,
    });
    expect(readOrganizationSettings(db, "org-b")?.recoveryReady).toBe(false);
    expect(readOrganizationSettings(db, "missing-org")).toBeNull();
  });

  test("admins update names through Better Auth and audits bounded values", async () => {
    const db = settingsDb();
    const adapter = updater(db);
    const result = await updateOrganizationName(
      db,
      adapter.update,
      {
        orgId: "org-a",
        actorUserId: "admin-user",
        requestId: "request-name",
        expectedName: "First Org",
        name: "Renamed Org",
      },
      headers,
    );

    expect(result).toBe("updated");
    expect(adapter.calls).toEqual([
      { organizationId: "org-a", data: { name: "Renamed Org" } },
    ]);
    expect(readOrganizationSettings(db, "org-a")?.name).toBe("Renamed Org");
    const audits = db
      .query<{ outcome: string; metadata_json: string }, []>(
        `SELECT outcome, metadata_json FROM organization_audit_event
          WHERE action = 'organization.settings_changed' ORDER BY seq`,
      )
      .all();
    expect(audits.map((event) => event.outcome)).toEqual([
      "intent",
      "succeeded",
    ]);
    expect(JSON.parse(audits[1]?.metadata_json ?? "{}")).toEqual({
      field: "name",
      fromValue: "First Org",
      toValue: "Renamed Org",
    });
  });

  test("uses the real Better Auth organization update path", async () => {
    const db = new Database(":memory:");
    const options = buildAuthOptions(db, TEST_SECRET);
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    migrateOrganizationAudit(db);
    migrateOrganizationPolicy(db);
    const auth = betterAuth(options);
    const signedUp = await auth.api.signUpEmail({
      body: {
        name: "Owner",
        email: "owner@example.test",
        password: "owner-password-123",
      },
      returnHeaders: true,
    });
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const authHeaders = new Headers({ cookie });
    const organization = await auth.api.createOrganization({
      body: { name: "Original Org", slug: "original-org" },
      headers: authHeaders,
    });

    expect(
      await updateOrganizationName(
        db,
        (body, forwarded) =>
          auth.api.updateOrganization({ body, headers: forwarded }),
        {
          orgId: organization.id,
          actorUserId: signedUp.response.user.id,
          requestId: "request-real-better-auth",
          expectedName: "Original Org",
          name: "Updated Through Better Auth",
        },
        authHeaders,
      ),
    ).toBe("updated");
    expect(readOrganizationSettings(db, organization.id)?.name).toBe(
      "Updated Through Better Auth",
    );

    const admin = await auth.api.signUpEmail({
      body: {
        name: "Admin",
        email: "admin@example.test",
        password: "admin-password-123",
      },
      returnHeaders: true,
    });
    const adminCookie = admin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const adminHeaders = new Headers({ cookie: adminCookie });
    db.query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('member-real-admin', ?, ?, 'admin', ?)`,
    ).run(organization.id, admin.response.user.id, new Date().toISOString());
    await auth.api.setActiveOrganization({
      body: { organizationId: organization.id },
      headers: adminHeaders,
    });
    expect(
      await updateOrganizationName(
        db,
        (body, forwarded) =>
          auth.api.updateOrganization({ body, headers: forwarded }),
        {
          orgId: organization.id,
          actorUserId: admin.response.user.id,
          requestId: "request-real-admin",
          expectedName: "Updated Through Better Auth",
          name: "Admin Updated Org",
        },
        adminHeaders,
      ),
    ).toBe("updated");

    db.query(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES ('reserved-org', 'Reserved Org', 'reserved-org', ?)`,
    ).run(new Date().toISOString());
    expect(
      await updateOrganizationSlug(
        db,
        (body, forwarded) =>
          auth.api.updateOrganization({ body, headers: forwarded }),
        {
          orgId: organization.id,
          actorUserId: signedUp.response.user.id,
          requestId: "request-real-slug-conflict",
          expectedSlug: "original-org",
          slug: "reserved-org",
          recentAuthentication: true,
        },
        authHeaders,
      ),
    ).toBe("conflict");
    expect(readOrganizationSettings(db, organization.id)?.slug).toBe(
      "original-org",
    );
  });

  test("slug changes require a live owner, recent authentication, and current value", async () => {
    const db = settingsDb();
    const adapter = updater(db);
    const base = {
      orgId: "org-a",
      actorUserId: "admin-user",
      requestId: "request-slug",
      expectedSlug: "first-org",
      slug: "renamed-org",
      recentAuthentication: true,
    };

    expect(
      await updateOrganizationSlug(db, adapter.update, base, headers),
    ).toBe("forbidden");
    db.query("UPDATE member SET role = 'owner' WHERE userId = 'admin-user'").run();
    expect(
      await updateOrganizationSlug(
        db,
        adapter.update,
        { ...base, recentAuthentication: false },
        headers,
      ),
    ).toBe("forbidden");
    expect(
      await updateOrganizationSlug(
        db,
        adapter.update,
        { ...base, expectedSlug: "stale-slug" },
        headers,
      ),
    ).toBe("conflict");
    expect(
      await updateOrganizationSlug(db, adapter.update, base, headers),
    ).toBe("updated");
    expect(readOrganizationSettings(db, "org-a")?.slug).toBe("renamed-org");
  });

  test("policy updates are owner-only, versioned, scoped, and atomically audited", () => {
    const db = settingsDb();
    createOrganizationAuditStore(
      db,
      () => "event-before-retention-change",
      () => new Date(Date.now() - 100 * 86_400_000),
    ).append({
      orgId: "org-a",
      actorUserId: "owner-user",
      action: "invitation.created",
      targetType: "invitation",
      targetId: "old-invitation",
      outcome: "succeeded",
      requestId: "request-old-invitation",
    });
    const input = {
      orgId: "org-a",
      actorUserId: "owner-user",
      requestId: "request-policy",
      expectedVersion: 0,
      defaultInvitationRole: "admin" as const,
      invitationLifetimeDays: 7,
      auditRetentionDays: 30,
      recentAuthentication: true,
    };

    expect(
      updateOrganizationPolicy(db, {
        ...input,
        recentAuthentication: false,
      }),
    ).toBe("forbidden");
    expect(readOrganizationSettings(db, "org-a")?.policyVersion).toBe(0);
    expect(updateOrganizationPolicy(db, input)).toBe("updated");
    expect(readOrganizationSettings(db, "org-a")).toMatchObject({
      defaultInvitationRole: "admin",
      invitationLifetimeDays: 7,
      auditRetentionDays: 30,
      policyVersion: 1,
    });
    expect(readOrganizationSettings(db, "org-b")).toMatchObject({
      defaultInvitationRole: "member",
      policyVersion: 0,
    });
    expect(updateOrganizationPolicy(db, input)).toBe("conflict");
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM organization_audit_event
            WHERE action = 'organization.settings_changed'
              AND outcome = 'succeeded'`,
        )
        .get(),
    ).toEqual({ count: 3 });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM organization_audit_event WHERE target_id = 'old-invitation'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  test("role changes between page render and mutation fail closed", () => {
    const db = settingsDb();
    const input = {
      orgId: "org-a",
      actorUserId: "owner-user",
      requestId: "request-demoted",
      expectedVersion: 0,
      defaultInvitationRole: "member" as const,
      invitationLifetimeDays: 7,
      auditRetentionDays: 365,
      recentAuthentication: true,
    };
    db.query("UPDATE member SET role = 'admin' WHERE userId = 'owner-user'").run();

    expect(updateOrganizationPolicy(db, input)).toBe("forbidden");
    expect(readOrganizationSettings(db, "org-a")?.policyVersion).toBe(0);
  });
});
