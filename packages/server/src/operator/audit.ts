import type { Database } from "bun:sqlite";
import { attemptSync } from "../util/result";
import { boundedId } from "./validation";

export type OperatorAuditAction =
  | "instance.settings_changed"
  | "operator.credential_replaced"
  | "operator.grant_created"
  | "operator.grant_revoked"
  | "organization.provisioned";

export type OperatorAuditTarget =
  | "instance-setting"
  | "operator-credential"
  | "operator-grant"
  | "organization";

export type OperatorAuditOutcome = "succeeded" | "failed";

export type InstanceSettingField =
  | "instance_name"
  | "support_url"
  | "system_prompt";

export interface OperatorAuditEvent {
  id: string;
  actorUserId: string;
  action: OperatorAuditAction;
  targetType: OperatorAuditTarget;
  targetId: string;
  outcome: OperatorAuditOutcome;
  requestId: string;
  field?: InstanceSettingField;
  createdAt: string;
}

export interface OperatorMutationInput {
  actorUserId: string;
  requestId: string;
  recentAuthentication: boolean;
}

interface AuditRow {
  id: string;
  actorUserId: string;
  action: OperatorAuditAction;
  targetType: OperatorAuditTarget;
  targetId: string;
  outcome: OperatorAuditOutcome;
  requestId: string;
  metadataJson: string;
  createdAt: string;
}

export const OPERATOR_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_operator_audit_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'instance.settings_changed',
    'operator.credential_replaced',
    'operator.grant_created',
    'operator.grant_revoked',
    'organization.provisioned'
  )),
  target_type TEXT NOT NULL CHECK(target_type IN (
    'instance-setting',
    'operator-credential',
    'operator-grant',
    'organization'
  )),
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed')),
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_instance_operator_audit_seq
  ON instance_operator_audit_event(seq DESC);
`;

function nowIso(now: () => Date) {
  return now().toISOString();
}

export function appendAudit(
  db: Database,
  event: Omit<OperatorAuditEvent, "id" | "createdAt">,
  now: () => Date,
) {
  db.query(
    `INSERT INTO instance_operator_audit_event
      (id, actor_user_id, action, target_type, target_id, outcome,
       request_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    event.actorUserId,
    event.action,
    event.targetType,
    event.targetId,
    event.outcome,
    event.requestId,
    JSON.stringify(event.field ? { field: event.field } : {}),
    nowIso(now),
  );
}

export function failedAudit(
  db: Database,
  input: OperatorMutationInput,
  action: OperatorAuditAction,
  targetType: OperatorAuditTarget,
  targetId: string,
  now: () => Date,
  field?: InstanceSettingField,
) {
  appendAudit(
    db,
    {
      actorUserId: boundedId(input.actorUserId) ?? "operator:unknown",
      action,
      targetType,
      targetId,
      outcome: "failed",
      requestId: boundedId(input.requestId) ?? crypto.randomUUID(),
      ...(field ? { field } : {}),
    },
    now,
  );
}

function readAuditRow(row: AuditRow) {
  let field: InstanceSettingField | undefined;
  const [error, metadata] = attemptSync(() => JSON.parse(row.metadataJson));
  if (
    !error &&
    typeof metadata === "object" &&
    metadata !== null &&
    "field" in metadata &&
    (metadata.field === "instance_name" ||
      metadata.field === "support_url" ||
      metadata.field === "system_prompt")
  ) {
    field = metadata.field;
  }
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    outcome: row.outcome,
    requestId: row.requestId,
    ...(field ? { field } : {}),
    createdAt: row.createdAt,
  } satisfies OperatorAuditEvent;
}

export function listOperatorAudit(db: Database, limit = 50) {
  const bounded =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 50) : 50;
  return db
    .query<AuditRow, [number]>(
      `SELECT id, actor_user_id AS actorUserId, action,
              target_type AS targetType, target_id AS targetId, outcome,
              request_id AS requestId, metadata_json AS metadataJson,
              created_at AS createdAt
         FROM instance_operator_audit_event
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(bounded)
    .map(readAuditRow);
}
