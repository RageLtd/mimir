import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateOrganizationAudit } from "../audit/store";
import {
  DEFAULT_INVITATION_LIFETIME_DAYS,
  DEFAULT_INVITATION_ROLE,
} from "./organization-settings-schema";
import {
  invitationExpiresAt,
  migrateOrganizationPolicy,
  readOrganizationPolicy,
} from "./organization-policy";

function policyDb() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE organization (id TEXT PRIMARY KEY) STRICT");
  db.run("INSERT INTO organization (id) VALUES ('org-a'), ('org-b')");
  migrateOrganizationAudit(db);
  migrateOrganizationPolicy(db);
  return db;
}

describe("organization policy", () => {
  test("migration is idempotent and absent rows use conservative defaults", () => {
    const db = policyDb();
    migrateOrganizationPolicy(db);

    expect(readOrganizationPolicy(db, "org-a")).toEqual({
      defaultInvitationRole: DEFAULT_INVITATION_ROLE,
      invitationLifetimeDays: DEFAULT_INVITATION_LIFETIME_DAYS,
      auditRetentionDays: 365,
      version: 0,
    });
    expect(readOrganizationPolicy(db, "missing-org")).toBeNull();
  });

  test("reads organization-scoped values and derives invitation expiry", () => {
    const db = policyDb();
    db.query(
      `INSERT INTO organization_policy
        (org_id, default_invitation_role, invitation_lifetime_days, version)
       VALUES (?, ?, ?, ?)`,
    ).run("org-a", "admin", 7, 3);
    db.query(
      `INSERT INTO organization_audit_policy (org_id, retention_days)
       VALUES (?, ?)`,
    ).run("org-a", 180);

    expect(readOrganizationPolicy(db, "org-a")).toEqual({
      defaultInvitationRole: "admin",
      invitationLifetimeDays: 7,
      auditRetentionDays: 180,
      version: 3,
    });
    expect(readOrganizationPolicy(db, "org-b")?.defaultInvitationRole).toBe(
      "member",
    );
    expect(
      invitationExpiresAt(
        db,
        "org-a",
        () => new Date("2026-07-14T00:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-07-21T00:00:00.000Z");
  });
});
