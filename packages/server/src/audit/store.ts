import type { Database } from "bun:sqlite";

export type OrganizationAuditAction =
  | "invitation.created"
  | "invitation.revoked"
  | "invitation.reissued"
  | "invitation.accepted"
  | "invitation.expired"
  | "membership.role_changed"
  | "membership.removed"
  | "organization.settings_changed"
  | "organization.ownership_changed"
  | "organization.deletion_scheduled"
  | "organization.deletion_cancelled"
  | "organization.deleted"
  | "encryption.generation_changed"
  | "memory.maintenance";

export type OrganizationAuditTarget =
  | "invitation"
  | "member"
  | "organization"
  | "encryption"
  | "memory-set";

export type OrganizationAuditOutcome = "intent" | "succeeded" | "failed";

export interface OrganizationAuditMetadata {
  count?: number;
  field?:
    | "name"
    | "slug"
    | "defaultInvitationRole"
    | "invitationLifetimeDays"
    | "auditRetentionDays";
  fromRole?: "owner" | "admin" | "member";
  toRole?: "owner" | "admin" | "member";
  generation?: number;
  reasonCode?:
    | "validation"
    | "unauthorized"
    | "conflict"
    | "dependency"
    | "unknown";
  retentionDays?: number;
}

export interface AppendOrganizationAuditEvent {
  orgId: string;
  actorUserId: string;
  action: OrganizationAuditAction;
  targetType: OrganizationAuditTarget;
  targetId: string;
  outcome: OrganizationAuditOutcome;
  requestId: string;
  metadata?: OrganizationAuditMetadata;
}

export interface OrganizationAuditFilters {
  action?: OrganizationAuditAction;
  actorUserId?: string;
  targetType?: OrganizationAuditTarget;
  outcome?: OrganizationAuditOutcome;
  fromDate?: string;
  cursor?: string;
  limit?: number;
}

export const ORGANIZATION_AUDIT_ACTIONS: readonly OrganizationAuditAction[] = [
  "invitation.created",
  "invitation.revoked",
  "invitation.reissued",
  "invitation.accepted",
  "invitation.expired",
  "membership.role_changed",
  "membership.removed",
  "organization.settings_changed",
  "organization.ownership_changed",
  "organization.deletion_scheduled",
  "organization.deletion_cancelled",
  "organization.deleted",
  "encryption.generation_changed",
  "memory.maintenance",
];

export const ORGANIZATION_AUDIT_TARGETS: readonly OrganizationAuditTarget[] = [
  "invitation",
  "member",
  "organization",
  "encryption",
  "memory-set",
];

export const ORGANIZATION_AUDIT_OUTCOMES: readonly OrganizationAuditOutcome[] =
  ["intent", "succeeded", "failed"];

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const MIN_AUDIT_RETENTION_DAYS = 30;
export const MAX_AUDIT_RETENTION_DAYS = 2_555;
export const MAX_AUDIT_PAGE_SIZE = 50;

export const ORGANIZATION_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS organization_audit_policy (
  org_id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT ${DEFAULT_AUDIT_RETENTION_DAYS}
    CHECK(retention_days BETWEEN ${MIN_AUDIT_RETENTION_DAYS} AND ${MAX_AUDIT_RETENTION_DAYS}),
  FOREIGN KEY(org_id) REFERENCES organization(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS organization_audit_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(org_id) REFERENCES organization(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_org_audit_org_seq
  ON organization_audit_event(org_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_org_audit_org_action_seq
  ON organization_audit_event(org_id, action, seq DESC);
`;

const ACTION_SET = new Set<string>(ORGANIZATION_AUDIT_ACTIONS);
const TARGET_SET = new Set<string>(ORGANIZATION_AUDIT_TARGETS);
const OUTCOME_SET = new Set<string>(ORGANIZATION_AUDIT_OUTCOMES);
const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireOpaqueId(label: string, value: string) {
  if (!OPAQUE_ID.test(value)) throw new Error(`${label} must be an opaque id`);
  return value;
}

function boundedInteger(value: number | undefined, min: number, max: number) {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

function isAuditAction(value: unknown): value is OrganizationAuditAction {
  return typeof value === "string" && ACTION_SET.has(value);
}

function isAuditTarget(value: unknown): value is OrganizationAuditTarget {
  return typeof value === "string" && TARGET_SET.has(value);
}

function isAuditOutcome(value: unknown): value is OrganizationAuditOutcome {
  return typeof value === "string" && OUTCOME_SET.has(value);
}

function isRole(value: unknown): value is "owner" | "admin" | "member" {
  return value === "owner" || value === "admin" || value === "member";
}

function isField(
  value: unknown,
): value is NonNullable<OrganizationAuditMetadata["field"]> {
  return (
    value === "name" ||
    value === "slug" ||
    value === "defaultInvitationRole" ||
    value === "invitationLifetimeDays" ||
    value === "auditRetentionDays"
  );
}

function isReasonCode(
  value: unknown,
): value is NonNullable<OrganizationAuditMetadata["reasonCode"]> {
  return (
    value === "validation" ||
    value === "unauthorized" ||
    value === "conflict" ||
    value === "dependency" ||
    value === "unknown"
  );
}

function safeMetadata(input: unknown) {
  if (typeof input !== "object" || input === null) return {};
  const count =
    "count" in input && typeof input.count === "number"
      ? boundedInteger(input.count, 0, 1_000_000)
      : undefined;
  const generation =
    "generation" in input && typeof input.generation === "number"
      ? boundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER)
      : undefined;
  const retentionDays =
    "retentionDays" in input && typeof input.retentionDays === "number"
      ? boundedInteger(
          input.retentionDays,
          MIN_AUDIT_RETENTION_DAYS,
          MAX_AUDIT_RETENTION_DAYS,
        )
      : undefined;
  return {
    ...(count === undefined ? {} : { count }),
    ...("field" in input && isField(input.field) ? { field: input.field } : {}),
    ...("fromRole" in input && isRole(input.fromRole)
      ? { fromRole: input.fromRole }
      : {}),
    ...("toRole" in input && isRole(input.toRole)
      ? { toRole: input.toRole }
      : {}),
    ...(generation === undefined ? {} : { generation }),
    ...("reasonCode" in input && isReasonCode(input.reasonCode)
      ? { reasonCode: input.reasonCode }
      : {}),
    ...(retentionDays === undefined ? {} : { retentionDays }),
  } satisfies OrganizationAuditMetadata;
}

function readMetadata(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return {};
    return safeMetadata(parsed);
  } catch {
    return {};
  }
}

function encodeCursor(seq: number) {
  return Buffer.from(String(seq)).toString("base64url");
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor || !/^[A-Za-z0-9_-]{1,32}$/.test(cursor)) return null;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readRow(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (
    !("seq" in value) ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("actor_user_id" in value) ||
    typeof value.actor_user_id !== "string" ||
    !("action" in value) ||
    !isAuditAction(value.action) ||
    !("target_type" in value) ||
    !isAuditTarget(value.target_type) ||
    !("target_id" in value) ||
    typeof value.target_id !== "string" ||
    !("outcome" in value) ||
    !isAuditOutcome(value.outcome) ||
    !("request_id" in value) ||
    typeof value.request_id !== "string" ||
    !("metadata_json" in value) ||
    typeof value.metadata_json !== "string" ||
    !("created_at" in value) ||
    typeof value.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    actorUserId: value.actor_user_id,
    action: value.action,
    targetType: value.target_type,
    targetId: value.target_id,
    outcome: value.outcome,
    requestId: value.request_id,
    metadata: readMetadata(value.metadata_json),
    createdAt: value.created_at,
    cursor: encodeCursor(value.seq),
  };
}

function retentionDays(db: Database, orgId: string) {
  const row: unknown = db
    .query(
      "SELECT retention_days FROM organization_audit_policy WHERE org_id = ?",
    )
    .get(orgId);
  if (
    typeof row === "object" &&
    row !== null &&
    "retention_days" in row &&
    typeof row.retention_days === "number"
  ) {
    return row.retention_days;
  }
  return DEFAULT_AUDIT_RETENTION_DAYS;
}

export function migrateOrganizationAudit(db: Database) {
  db.run(ORGANIZATION_AUDIT_SCHEMA);
}

export function appendOrganizationAuditEvent(
  db: Database,
  input: AppendOrganizationAuditEvent,
  id: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
) {
  requireOpaqueId("organization", input.orgId);
  requireOpaqueId("actor", input.actorUserId);
  requireOpaqueId("target", input.targetId);
  requireOpaqueId("request", input.requestId);
  if (!isAuditAction(input.action)) throw new Error("invalid audit action");
  if (!isAuditTarget(input.targetType)) throw new Error("invalid audit target");
  if (!isAuditOutcome(input.outcome)) throw new Error("invalid audit outcome");

  const eventId = requireOpaqueId("event", id());
  const createdAt = now().toISOString();
  const metadata = safeMetadata(input.metadata);
  db.run(
    `INSERT INTO organization_audit_event
      (id, org_id, actor_user_id, action, target_type, target_id, outcome, request_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      input.orgId,
      input.actorUserId,
      input.action,
      input.targetType,
      input.targetId,
      input.outcome,
      input.requestId,
      JSON.stringify(metadata),
      createdAt,
    ],
  );
  db.run(
    "DELETE FROM organization_audit_event WHERE org_id = ? AND created_at < ?",
    [
      input.orgId,
      new Date(
        new Date(createdAt).valueOf() -
          retentionDays(db, input.orgId) * 86_400_000,
      ).toISOString(),
    ],
  );
  return { id: eventId, createdAt };
}

export function createOrganizationAuditStore(
  db: Database,
  id: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
) {
  const append = (input: AppendOrganizationAuditEvent) =>
    db.transaction(() => appendOrganizationAuditEvent(db, input, id, now))();

  const list = (orgId: string, filters: OrganizationAuditFilters = {}) => {
    requireOpaqueId("organization", orgId);
    const policyRetentionDays = retentionDays(db, orgId);
    const cutoff = new Date(
      now().valueOf() - policyRetentionDays * 86_400_000,
    ).toISOString();
    const clauses = ["org_id = ?", "created_at >= ?"];
    const bindings: Array<string | number> = [orgId, cutoff];
    if (filters.action !== undefined) {
      if (!isAuditAction(filters.action))
        throw new Error("invalid audit action");
      clauses.push("action = ?");
      bindings.push(filters.action);
    }
    if (filters.actorUserId) {
      clauses.push("actor_user_id = ?");
      bindings.push(requireOpaqueId("actor", filters.actorUserId));
    }
    if (filters.targetType !== undefined) {
      if (!isAuditTarget(filters.targetType))
        throw new Error("invalid audit target");
      clauses.push("target_type = ?");
      bindings.push(filters.targetType);
    }
    if (filters.outcome !== undefined) {
      if (!isAuditOutcome(filters.outcome)) {
        throw new Error("invalid audit outcome");
      }
      clauses.push("outcome = ?");
      bindings.push(filters.outcome);
    }
    if (filters.fromDate) {
      const date = new Date(`${filters.fromDate}T00:00:00.000Z`);
      if (
        !ISO_DATE.test(filters.fromDate) ||
        Number.isNaN(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== filters.fromDate
      ) {
        throw new Error("invalid audit date");
      }
      clauses.push("created_at >= ?");
      bindings.push(`${filters.fromDate}T00:00:00.000Z`);
    }
    const cursor = decodeCursor(filters.cursor);
    if (filters.cursor && !cursor) throw new Error("invalid audit cursor");
    if (cursor) {
      clauses.push("seq < ?");
      bindings.push(cursor);
    }
    const limit = boundedInteger(filters.limit, 1, MAX_AUDIT_PAGE_SIZE) ?? 25;
    bindings.push(limit + 1);
    const rows: unknown[] = db
      .query(
        `SELECT seq, id, org_id, actor_user_id, action, target_type, target_id,
                outcome, request_id, metadata_json, created_at
           FROM organization_audit_event
          WHERE ${clauses.join(" AND ")}
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(...bindings);
    const events = rows.flatMap((row) => {
      const event = readRow(row);
      return event ? [event] : [];
    });
    const hasNextPage = events.length > limit;
    const page = hasNextPage ? events.slice(0, limit) : events;
    return {
      events: page,
      nextCursor: hasNextPage ? (page.at(-1)?.cursor ?? null) : null,
      retentionDays: policyRetentionDays,
    };
  };

  return { append, list };
}
