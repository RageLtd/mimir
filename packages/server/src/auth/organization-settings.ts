import type { Database } from "bun:sqlite";
import {
  appendOrganizationAuditEvent,
  type OrganizationAuditMetadata,
} from "../audit/store";
import { attempt } from "../util/result";
import {
  type OrganizationPolicy,
  readOrganizationPolicy,
} from "./organization-policy";
import {
  auditRetentionDays,
  defaultInvitationRole,
  invitationLifetimeDays,
  type OrganizationSettingField,
  organizationName,
  organizationSlug,
} from "./organization-settings-schema";

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  keyGeneration: number | null;
  recoveryPublicKey: string | null;
  wrappedRecoveryKey: string | null;
}

interface MutationIdentity {
  orgId: string;
  actorUserId: string;
  requestId: string;
}

export interface UpdateOrganizationNameInput extends MutationIdentity {
  expectedName: string;
  name: string;
}

export interface UpdateOrganizationSlugInput extends MutationIdentity {
  expectedSlug: string;
  slug: string;
  recentAuthentication: boolean;
}

export interface UpdateOrganizationPolicyInput extends MutationIdentity {
  expectedVersion: number;
  defaultInvitationRole: string;
  invitationLifetimeDays: number;
  auditRetentionDays: number;
  recentAuthentication: boolean;
}

export type OrganizationUpdater = (
  input: {
    organizationId: string;
    data: { name?: string; slug?: string };
  },
  headers: Headers,
) => Promise<unknown>;

interface SettingChange {
  field: OrganizationSettingField;
  fromValue: string | number;
  toValue: string | number;
}

function organizationRow(db: Database, orgId: string) {
  return db
    .query<OrganizationRow, [string]>(
      `SELECT id, name, slug, keyGeneration, recoveryPublicKey,
              wrappedRecoveryKey
         FROM organization WHERE id = ?`,
    )
    .get(orgId);
}

function activeRole(db: Database, orgId: string, userId: string) {
  const member = db
    .query<{ role: string }, [string, string]>(
      "SELECT role FROM member WHERE organizationId = ? AND userId = ?",
    )
    .get(orgId, userId);
  if (!member) return null;
  const roles = new Set(member.role.split(",").map((role) => role.trim()));
  if (roles.has("owner")) return "owner";
  if (roles.has("admin")) return "admin";
  return "member";
}

function auditChanges(
  db: Database,
  input: MutationIdentity,
  changes: SettingChange[],
  outcome: "intent" | "succeeded" | "failed",
  reason?: string,
) {
  const failureReason = reason
    ? reason === "conflict"
      ? "conflict"
      : reason === "forbidden"
        ? "unauthorized"
        : reason === "validation" || reason === "not_found"
          ? "validation"
          : "dependency"
    : undefined;
  for (const change of changes) {
    const metadata: OrganizationAuditMetadata = {
      field: change.field,
      fromValue: change.fromValue,
      toValue: change.toValue,
      ...(failureReason ? { reasonCode: failureReason } : {}),
      ...(change.field === "auditRetentionDays"
        ? { retentionDays: Number(change.toValue) }
        : {}),
    };
    appendOrganizationAuditEvent(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "organization.settings_changed",
      targetType: "organization",
      targetId: input.orgId,
      outcome,
      requestId: input.requestId,
      metadata,
    });
  }
}

function settingChanges(
  current: OrganizationPolicy,
  next: {
    defaultInvitationRole: "admin" | "member";
    invitationLifetimeDays: number;
    auditRetentionDays: number;
  },
) {
  const changes: SettingChange[] = [];
  if (current.defaultInvitationRole !== next.defaultInvitationRole) {
    changes.push({
      field: "defaultInvitationRole",
      fromValue: current.defaultInvitationRole,
      toValue: next.defaultInvitationRole,
    });
  }
  if (current.invitationLifetimeDays !== next.invitationLifetimeDays) {
    changes.push({
      field: "invitationLifetimeDays",
      fromValue: current.invitationLifetimeDays,
      toValue: next.invitationLifetimeDays,
    });
  }
  if (current.auditRetentionDays !== next.auditRetentionDays) {
    changes.push({
      field: "auditRetentionDays",
      fromValue: current.auditRetentionDays,
      toValue: next.auditRetentionDays,
    });
  }
  return changes;
}

export function readOrganizationSettings(db: Database, orgId: string) {
  const organization = organizationRow(db, orgId);
  const policy = readOrganizationPolicy(db, orgId);
  if (!organization || !policy) return null;
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    defaultInvitationRole: policy.defaultInvitationRole,
    invitationLifetimeDays: policy.invitationLifetimeDays,
    auditRetentionDays: policy.auditRetentionDays,
    policyVersion: policy.version,
    keyGeneration: organization.keyGeneration,
    recoveryReady: Boolean(
      organization.recoveryPublicKey && organization.wrappedRecoveryKey,
    ),
  };
}

export async function updateOrganizationName(
  db: Database,
  update: OrganizationUpdater,
  input: UpdateOrganizationNameInput,
  headers: Headers,
) {
  const current = organizationRow(db, input.orgId);
  if (!current) return "not_found";
  const normalized = organizationName(input.name);
  const changes: SettingChange[] = [
    {
      field: "name",
      fromValue: current.name,
      toValue: normalized ?? input.name,
    },
  ];
  auditChanges(db, input, changes, "intent");
  if (!normalized) {
    auditChanges(db, input, changes, "failed", "validation");
    return "validation";
  }
  if (current.name !== input.expectedName) {
    auditChanges(db, input, changes, "failed", "conflict");
    return "conflict";
  }
  const role = activeRole(db, input.orgId, input.actorUserId);
  if (role !== "owner" && role !== "admin") {
    auditChanges(db, input, changes, "failed", "forbidden");
    return "forbidden";
  }
  if (current.name === normalized) {
    auditChanges(db, input, changes, "succeeded");
    return "unchanged";
  }
  const [error] = await attempt(() =>
    update(
      { organizationId: input.orgId, data: { name: normalized } },
      headers,
    ),
  );
  const updated = organizationRow(db, input.orgId);
  if (error || updated?.name !== normalized) {
    auditChanges(db, input, changes, "failed", "dependency");
    return "failed";
  }
  auditChanges(db, input, changes, "succeeded");
  return "updated";
}

export async function updateOrganizationSlug(
  db: Database,
  update: OrganizationUpdater,
  input: UpdateOrganizationSlugInput,
  headers: Headers,
) {
  const current = organizationRow(db, input.orgId);
  if (!current) return "not_found";
  const normalized = organizationSlug(input.slug);
  const changes: SettingChange[] = [
    {
      field: "slug",
      fromValue: current.slug,
      toValue: normalized ?? input.slug,
    },
  ];
  auditChanges(db, input, changes, "intent");
  if (!normalized) {
    auditChanges(db, input, changes, "failed", "validation");
    return "validation";
  }
  if (current.slug !== input.expectedSlug) {
    auditChanges(db, input, changes, "failed", "conflict");
    return "conflict";
  }
  if (
    !input.recentAuthentication ||
    activeRole(db, input.orgId, input.actorUserId) !== "owner"
  ) {
    auditChanges(db, input, changes, "failed", "forbidden");
    return "forbidden";
  }
  if (current.slug === normalized) {
    auditChanges(db, input, changes, "succeeded");
    return "unchanged";
  }
  const [error] = await attempt(() =>
    update(
      { organizationId: input.orgId, data: { slug: normalized } },
      headers,
    ),
  );
  const updated = organizationRow(db, input.orgId);
  if (error || updated?.slug !== normalized) {
    auditChanges(
      db,
      input,
      changes,
      "failed",
      error ? "conflict" : "dependency",
    );
    return error ? "conflict" : "failed";
  }
  auditChanges(db, input, changes, "succeeded");
  return "updated";
}

export function updateOrganizationPolicy(
  db: Database,
  input: UpdateOrganizationPolicyInput,
) {
  const current = readOrganizationPolicy(db, input.orgId);
  if (!current) return "not_found";
  const nextRole = defaultInvitationRole(input.defaultInvitationRole);
  const nextLifetime = invitationLifetimeDays(input.invitationLifetimeDays);
  const nextRetention = auditRetentionDays(input.auditRetentionDays);
  if (!nextRole || !nextLifetime || !nextRetention) return "validation";
  const next = {
    defaultInvitationRole: nextRole,
    invitationLifetimeDays: nextLifetime,
    auditRetentionDays: nextRetention,
  };
  const changes = settingChanges(current, next);
  if (changes.length > 0) auditChanges(db, input, changes, "intent");
  if (
    !input.recentAuthentication ||
    activeRole(db, input.orgId, input.actorUserId) !== "owner"
  ) {
    if (changes.length > 0) {
      auditChanges(db, input, changes, "failed", "forbidden");
    }
    return "forbidden";
  }
  if (current.version !== input.expectedVersion) {
    if (changes.length > 0) {
      auditChanges(db, input, changes, "failed", "conflict");
    }
    return "conflict";
  }
  if (changes.length === 0) return "unchanged";

  const result = db.transaction(() => {
    const live = readOrganizationPolicy(db, input.orgId);
    if (!live || live.version !== input.expectedVersion) return "conflict";
    if (activeRole(db, input.orgId, input.actorUserId) !== "owner") {
      return "forbidden";
    }
    db.query(
      `INSERT INTO organization_policy
        (org_id, default_invitation_role, invitation_lifetime_days, version)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(org_id) DO UPDATE SET
         default_invitation_role = excluded.default_invitation_role,
         invitation_lifetime_days = excluded.invitation_lifetime_days,
         version = organization_policy.version + 1`,
    ).run(input.orgId, nextRole, nextLifetime);
    db.query(
      `INSERT INTO organization_audit_policy (org_id, retention_days)
       VALUES (?, ?)
       ON CONFLICT(org_id) DO UPDATE SET retention_days = excluded.retention_days`,
    ).run(input.orgId, nextRetention);
    auditChanges(db, input, changes, "succeeded");
    return "updated";
  })();

  if (result !== "updated") {
    auditChanges(db, input, changes, "failed", result);
  }
  return result;
}
