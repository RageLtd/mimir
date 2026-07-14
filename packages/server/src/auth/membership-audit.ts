import type { Database } from "bun:sqlite";
import {
  createOrganizationAuditStore,
  type OrganizationAuditMetadata,
} from "../audit/store";

export interface MutationIdentity {
  orgId: string;
  actorUserId: string;
  requestId: string;
}

function failureMetadata(reason: string): OrganizationAuditMetadata {
  return {
    reasonCode:
      reason === "conflict"
        ? "conflict"
        : reason === "forbidden" || reason === "last_owner"
          ? "unauthorized"
          : reason === "not_found" ||
              reason === "invalid_wraps" ||
              reason === "key_not_ready"
            ? "validation"
            : "dependency",
  };
}

export function auditFailure(
  db: Database,
  input: MutationIdentity,
  action:
    | "membership.role_changed"
    | "membership.removed"
    | "organization.ownership_changed"
    | "encryption.generation_changed",
  targetType: "member" | "encryption",
  targetId: string,
  reason: string,
  metadata: OrganizationAuditMetadata = {},
) {
  createOrganizationAuditStore(db).append({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action,
    targetType,
    targetId,
    outcome: "failed",
    requestId: input.requestId,
    metadata: { ...metadata, ...failureMetadata(reason) },
  });
}

export function auditOwnershipChange(
  db: Database,
  input: MutationIdentity,
  targetId: string,
  outcome: "intent" | "succeeded" | "failed",
  metadata: OrganizationAuditMetadata,
  reason?: string,
) {
  if (outcome === "failed") {
    return auditFailure(
      db,
      input,
      "organization.ownership_changed",
      "member",
      targetId,
      reason ?? "dependency",
      metadata,
    );
  }
  createOrganizationAuditStore(db).append({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action: "organization.ownership_changed",
    targetType: "member",
    targetId,
    outcome,
    requestId: input.requestId,
    metadata,
  });
}
