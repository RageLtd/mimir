import type { Database } from "bun:sqlite";
import {
  auditRetentionDays,
  DEFAULT_AUDIT_RETENTION_DAYS,
  DEFAULT_INVITATION_LIFETIME_DAYS,
  DEFAULT_INVITATION_ROLE,
  defaultInvitationRole,
  invitationLifetimeDays,
} from "./organization-settings-schema";

interface PolicyRow {
  defaultInvitationRole: string;
  invitationLifetimeDays: number;
  auditRetentionDays: number | null;
  version: number;
}

export interface OrganizationPolicy {
  defaultInvitationRole: "admin" | "member";
  invitationLifetimeDays: number;
  auditRetentionDays: number;
  version: number;
}

export const ORGANIZATION_POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS organization_policy (
  org_id TEXT PRIMARY KEY,
  default_invitation_role TEXT NOT NULL DEFAULT '${DEFAULT_INVITATION_ROLE}'
    CHECK(default_invitation_role IN ('admin', 'member')),
  invitation_lifetime_days INTEGER NOT NULL DEFAULT ${DEFAULT_INVITATION_LIFETIME_DAYS}
    CHECK(invitation_lifetime_days BETWEEN 1 AND 30),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  FOREIGN KEY(org_id) REFERENCES organization(id) ON DELETE CASCADE
) STRICT;
`;

export function migrateOrganizationPolicy(db: Database) {
  db.run(ORGANIZATION_POLICY_SCHEMA);
}

export function readOrganizationPolicy(db: Database, orgId: string) {
  const organization = db
    .query<{ id: string }, [string]>("SELECT id FROM organization WHERE id = ?")
    .get(orgId);
  if (!organization) return null;
  const row = db
    .query<PolicyRow, [string]>(
      `SELECT p.default_invitation_role AS defaultInvitationRole,
              p.invitation_lifetime_days AS invitationLifetimeDays,
              a.retention_days AS auditRetentionDays,
              p.version
         FROM organization_policy p
         LEFT JOIN organization_audit_policy a ON a.org_id = p.org_id
        WHERE p.org_id = ?`,
    )
    .get(orgId);
  const auditRow = row
    ? null
    : db
        .query<{ auditRetentionDays: number }, [string]>(
          `SELECT retention_days AS auditRetentionDays
             FROM organization_audit_policy WHERE org_id = ?`,
        )
        .get(orgId);
  return {
    defaultInvitationRole:
      defaultInvitationRole(row?.defaultInvitationRole) ??
      DEFAULT_INVITATION_ROLE,
    invitationLifetimeDays:
      invitationLifetimeDays(row?.invitationLifetimeDays) ??
      DEFAULT_INVITATION_LIFETIME_DAYS,
    auditRetentionDays:
      auditRetentionDays(row?.auditRetentionDays) ??
      auditRetentionDays(auditRow?.auditRetentionDays) ??
      DEFAULT_AUDIT_RETENTION_DAYS,
    version: row?.version ?? 0,
  };
}

export function invitationExpiresAt(
  db: Database,
  orgId: string,
  now: () => Date = () => new Date(),
) {
  const days =
    readOrganizationPolicy(db, orgId)?.invitationLifetimeDays ??
    DEFAULT_INVITATION_LIFETIME_DAYS;
  return new Date(now().valueOf() + days * 86_400_000);
}
