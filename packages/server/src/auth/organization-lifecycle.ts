import type { Database } from "bun:sqlite";
import {
  appendOrganizationAuditEvent,
  type OrganizationAuditAction,
} from "../audit/store";
import { attemptSync } from "../util/result";

export const ORGANIZATION_DELETION_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export const ORGANIZATION_LIFECYCLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS organization_deletion_schedule (
  org_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled', 'purging')),
  FOREIGN KEY(org_id) REFERENCES organization(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_org_deletion_due
  ON organization_deletion_schedule(status, purge_after);

CREATE TABLE IF NOT EXISTS organization_deletion_receipt (
  org_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome = 'succeeded')
) STRICT;
`;

interface LifecycleMutationInput {
  orgId: string;
  actorUserId: string;
  requestId: string;
  recentAuthentication: boolean;
}

export interface ScheduleOrganizationDeletionInput
  extends LifecycleMutationInput {
  confirmation: string;
}

export interface CancelOrganizationDeletionInput
  extends LifecycleMutationInput {
  scheduleId: string;
}

interface OrganizationRow {
  id: string;
  name: string;
}

interface ScheduleRow {
  orgId: string;
  scheduleId: string;
  actorUserId: string;
  requestId: string;
  scheduledAt: string;
  purgeAfter: string;
  status: "scheduled" | "purging";
}

function scheduleRow(db: Database, orgId: string) {
  return db
    .query<ScheduleRow, [string]>(
      `SELECT org_id AS orgId, schedule_id AS scheduleId,
              actor_user_id AS actorUserId, request_id AS requestId,
              scheduled_at AS scheduledAt, purge_after AS purgeAfter, status
         FROM organization_deletion_schedule WHERE org_id = ?`,
    )
    .get(orgId);
}

function organizationRow(db: Database, orgId: string) {
  return db
    .query<OrganizationRow, [string]>(
      "SELECT id, name FROM organization WHERE id = ?",
    )
    .get(orgId);
}

function role(db: Database, orgId: string, userId: string) {
  return db
    .query<{ role: string }, [string, string]>(
      "SELECT role FROM member WHERE organizationId = ? AND userId = ?",
    )
    .get(orgId, userId)?.role;
}

function ownerRole(value: string | undefined) {
  return new Set(value?.split(",").map((entry) => entry.trim())).has("owner");
}

function audit(
  db: Database,
  input: LifecycleMutationInput,
  action: Extract<
    OrganizationAuditAction,
    "organization.deletion_scheduled" | "organization.deletion_cancelled"
  >,
  outcome: "intent" | "succeeded" | "failed",
  reasonCode?: "validation" | "unauthorized" | "conflict" | "dependency",
) {
  appendOrganizationAuditEvent(db, {
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action,
    targetType: "organization",
    targetId: input.orgId,
    outcome,
    requestId: input.requestId,
    metadata: reasonCode ? { reasonCode } : {},
  });
}

export function migrateOrganizationLifecycle(db: Database) {
  db.run(ORGANIZATION_LIFECYCLE_SCHEMA);
}

export function readOrganizationLifecycle(db: Database, orgId: string) {
  if (!organizationRow(db, orgId)) return null;
  const owners = db
    .query<{ role: string; wrappedOrgKey: string | null }, [string]>(
      "SELECT role, wrappedOrgKey FROM member WHERE organizationId = ?",
    )
    .all(orgId)
    .filter((member) => ownerRole(member.role));
  const deletion = scheduleRow(db, orgId);
  return {
    ownerCount: owners.length,
    keyedOwnerCount: owners.filter((owner) => owner.wrappedOrgKey !== null)
      .length,
    deletion: deletion
      ? {
          scheduleId: deletion.scheduleId,
          scheduledAt: deletion.scheduledAt,
          purgeAfter: deletion.purgeAfter,
          status: deletion.status,
        }
      : null,
  };
}

export function organizationDeletionPending(db: Database, orgId: string) {
  return scheduleRow(db, orgId) !== null;
}

export function scheduleOrganizationDeletion(
  db: Database,
  input: ScheduleOrganizationDeletionInput,
  id: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
) {
  const initial = organizationRow(db, input.orgId);
  if (!initial) return "not_found";
  audit(db, input, "organization.deletion_scheduled", "intent");
  if (!input.recentAuthentication || input.confirmation !== initial.name) {
    audit(
      db,
      input,
      "organization.deletion_scheduled",
      "failed",
      input.recentAuthentication ? "validation" : "unauthorized",
    );
    return input.recentAuthentication ? "validation" : "forbidden";
  }

  const scheduledAt = now();
  const purgeAfter = new Date(
    scheduledAt.valueOf() + ORGANIZATION_DELETION_GRACE_DAYS * DAY_MS,
  );
  const scheduleId = `schedule:${id()}`;
  const result = db.transaction(() => {
    const organization = organizationRow(db, input.orgId);
    if (!organization) return "not_found";
    if (organization.name !== input.confirmation) return "conflict";
    if (!ownerRole(role(db, input.orgId, input.actorUserId))) {
      return "forbidden";
    }
    if (scheduleRow(db, input.orgId)) return "conflict";
    db.query(
      `INSERT INTO organization_deletion_schedule
        (org_id, schedule_id, actor_user_id, request_id, scheduled_at, purge_after)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.orgId,
      scheduleId,
      input.actorUserId,
      input.requestId,
      scheduledAt.toISOString(),
      purgeAfter.toISOString(),
    );
    appendOrganizationAuditEvent(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "organization.deletion_scheduled",
      targetType: "organization",
      targetId: input.orgId,
      outcome: "succeeded",
      requestId: input.requestId,
    });
    return "scheduled";
  })();
  if (result !== "scheduled") {
    audit(
      db,
      input,
      "organization.deletion_scheduled",
      "failed",
      result === "conflict"
        ? "conflict"
        : result === "forbidden"
          ? "unauthorized"
          : "dependency",
    );
  }
  return result;
}

export function cancelOrganizationDeletion(
  db: Database,
  input: CancelOrganizationDeletionInput,
) {
  if (!organizationRow(db, input.orgId)) return "not_found";
  audit(db, input, "organization.deletion_cancelled", "intent");
  if (!input.recentAuthentication) {
    audit(
      db,
      input,
      "organization.deletion_cancelled",
      "failed",
      "unauthorized",
    );
    return "forbidden";
  }
  const result = db.transaction(() => {
    if (!ownerRole(role(db, input.orgId, input.actorUserId))) {
      return "forbidden";
    }
    const scheduled = scheduleRow(db, input.orgId);
    if (
      !scheduled ||
      scheduled.scheduleId !== input.scheduleId ||
      scheduled.status !== "scheduled"
    ) {
      return "conflict";
    }
    db.query(
      "DELETE FROM organization_deletion_schedule WHERE org_id = ? AND schedule_id = ? AND status = 'scheduled'",
    ).run(input.orgId, input.scheduleId);
    appendOrganizationAuditEvent(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "organization.deletion_cancelled",
      targetType: "organization",
      targetId: input.orgId,
      outcome: "succeeded",
      requestId: input.requestId,
    });
    return "cancelled";
  })();
  if (result !== "cancelled") {
    audit(
      db,
      input,
      "organization.deletion_cancelled",
      "failed",
      result === "conflict" ? "conflict" : "unauthorized",
    );
  }
  return result;
}

function dueSchedules(db: Database, now: Date) {
  return db
    .query<ScheduleRow, [string]>(
      `SELECT org_id AS orgId, schedule_id AS scheduleId,
              actor_user_id AS actorUserId, request_id AS requestId,
              scheduled_at AS scheduledAt, purge_after AS purgeAfter, status
         FROM organization_deletion_schedule
        WHERE status = 'purging' OR purge_after <= ?
        ORDER BY purge_after, org_id`,
    )
    .all(now.toISOString());
}

function claimPurge(db: Database, schedule: ScheduleRow, now: Date) {
  return db.transaction(() => {
    const current = scheduleRow(db, schedule.orgId);
    if (!current || current.scheduleId !== schedule.scheduleId) return null;
    if (
      current.status === "scheduled" &&
      new Date(current.purgeAfter).valueOf() > now.valueOf()
    ) {
      return null;
    }
    if (current.status === "scheduled") {
      db.query(
        "UPDATE organization_deletion_schedule SET status = 'purging' WHERE org_id = ? AND schedule_id = ? AND status = 'scheduled'",
      ).run(current.orgId, current.scheduleId);
    }
    return { ...current, status: "purging" } satisfies ScheduleRow;
  })();
}

function purgeTenantState(db: Database, orgId: string) {
  db.transaction(() => {
    db.query("DELETE FROM envelope WHERE org_id = ?").run(orgId);
    db.query("DELETE FROM sync_cursor WHERE org_id = ?").run(orgId);
    db.query("DELETE FROM lease WHERE org_id = ?").run(orgId);
  })();
}

function finalizePurge(db: Database, schedule: ScheduleRow, now: Date) {
  return db.transaction(() => {
    const current = scheduleRow(db, schedule.orgId);
    if (
      !current ||
      current.scheduleId !== schedule.scheduleId ||
      current.status !== "purging"
    ) {
      return "stale";
    }
    appendOrganizationAuditEvent(db, {
      orgId: current.orgId,
      actorUserId: current.actorUserId,
      action: "organization.deleted",
      targetType: "organization",
      targetId: current.orgId,
      outcome: "intent",
      requestId: current.requestId,
    });
    appendOrganizationAuditEvent(db, {
      orgId: current.orgId,
      actorUserId: current.actorUserId,
      action: "organization.deleted",
      targetType: "organization",
      targetId: current.orgId,
      outcome: "succeeded",
      requestId: current.requestId,
    });
    db.query(
      `INSERT OR IGNORE INTO organization_deletion_receipt
        (org_id, actor_user_id, request_id, scheduled_at, purge_after, purged_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'succeeded')`,
    ).run(
      current.orgId,
      current.actorUserId,
      current.requestId,
      current.scheduledAt,
      current.purgeAfter,
      now.toISOString(),
    );
    db.query(
      "UPDATE session SET activeOrganizationId = NULL WHERE activeOrganizationId = ?",
    ).run(current.orgId);
    db.query("DELETE FROM invitation WHERE organizationId = ?").run(
      current.orgId,
    );
    db.query("DELETE FROM member WHERE organizationId = ?").run(current.orgId);
    db.query("DELETE FROM organization_policy WHERE org_id = ?").run(
      current.orgId,
    );
    db.query("DELETE FROM organization_audit_policy WHERE org_id = ?").run(
      current.orgId,
    );
    db.query("DELETE FROM organization_audit_event WHERE org_id = ?").run(
      current.orgId,
    );
    db.query("DELETE FROM organization_deletion_schedule WHERE org_id = ?").run(
      current.orgId,
    );
    db.query("DELETE FROM organization WHERE id = ?").run(current.orgId);
    return "purged";
  })();
}

export function purgeDueOrganizations(
  authDb: Database,
  tenantDb: Database,
  now: () => Date = () => new Date(),
) {
  const current = now();
  return dueSchedules(authDb, current).map((schedule) => {
    const [error, result] = attemptSync(() => {
      const claimed = claimPurge(authDb, schedule, current);
      if (!claimed) return "stale";
      purgeTenantState(tenantDb, claimed.orgId);
      return finalizePurge(authDb, claimed, current);
    });
    return {
      orgId: schedule.orgId,
      status: error ? "failed" : result,
      ...(error ? { error } : {}),
    };
  });
}
