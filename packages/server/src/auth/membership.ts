import type { Database } from "bun:sqlite";
import {
  appendOrganizationAuditEvent,
  createOrganizationAuditStore,
  type OrganizationAuditMetadata,
} from "../audit/store";

export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationKeyWrap {
  memberId: string;
  wrappedOrgKey: string;
}

export interface OrganizationRecoveryWrap {
  recoveryPublicKey: string;
  wrappedRecoveryKey: string;
}

interface MemberRecord {
  id: string;
  userId: string;
  role: string;
  publicKey: string | null;
  wrappedOrgKey: string | null;
}

interface OrganizationKeyRecord {
  keyGeneration: number | null;
  recoveryPublicKey: string | null;
}

interface MutationIdentity {
  orgId: string;
  actorUserId: string;
  requestId: string;
}

interface ChangeRoleInput extends MutationIdentity {
  memberId: string;
  role: OrganizationRole;
}

interface RotateKeyInput extends MutationIdentity {
  keyGeneration: number;
  wraps: OrganizationKeyWrap[];
  recovery?: OrganizationRecoveryWrap;
  removeMemberId?: string;
}

const roles = (value: string) =>
  new Set(
    value
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  );

const hasRole = (member: MemberRecord, role: OrganizationRole) =>
  roles(member.role).has(role);

function effectiveRole(member: MemberRecord): OrganizationRole {
  if (hasRole(member, "owner")) return "owner";
  if (hasRole(member, "admin")) return "admin";
  return "member";
}

function membersForOrganization(db: Database, orgId: string) {
  return db
    .query<MemberRecord, [string]>(
      `SELECT m.id, m.userId, m.role, u.publicKey, m.wrappedOrgKey
         FROM member m JOIN "user" u ON u.id = m.userId
        WHERE m.organizationId = ?`,
    )
    .all(orgId);
}

function memberMutationReason(
  members: MemberRecord[],
  actorUserId: string,
  targetMemberId: string,
  nextRole?: OrganizationRole,
) {
  const actor = members.find((member) => member.userId === actorUserId);
  const target = members.find((member) => member.id === targetMemberId);
  if (!actor || !target) return "not_found";

  const actorIsOwner = hasRole(actor, "owner");
  const actorIsAdmin = hasRole(actor, "admin");
  if (!actorIsOwner && !actorIsAdmin) return "forbidden";

  const targetIsOwner = hasRole(target, "owner");
  if ((targetIsOwner || nextRole === "owner") && !actorIsOwner) {
    return "forbidden";
  }
  if (
    targetIsOwner &&
    nextRole !== "owner" &&
    members.filter((member) => hasRole(member, "owner")).length === 1
  ) {
    return "last_owner";
  }
  return null;
}

function failureMetadata(reason: string): OrganizationAuditMetadata {
  return {
    reasonCode:
      reason === "conflict"
        ? "conflict"
        : reason === "forbidden" || reason === "last_owner"
          ? "unauthorized"
          : reason === "not_found" || reason === "invalid_wraps"
            ? "validation"
            : "dependency",
  };
}

function auditFailure(
  db: Database,
  input: MutationIdentity,
  action:
    | "membership.role_changed"
    | "membership.removed"
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

export function changeOrganizationMemberRole(
  db: Database,
  input: ChangeRoleInput,
) {
  const audit = createOrganizationAuditStore(db);
  const initialMembers = membersForOrganization(db, input.orgId);
  const initialTarget = initialMembers.find(
    (member) => member.id === input.memberId,
  );
  const fromRole = initialTarget ? effectiveRole(initialTarget) : undefined;
  const metadata = {
    ...(fromRole ? { fromRole } : {}),
    toRole: input.role,
  };
  audit.append({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action: "membership.role_changed",
    targetType: "member",
    targetId: input.memberId,
    outcome: "intent",
    requestId: input.requestId,
    metadata,
  });
  const initialReason = memberMutationReason(
    initialMembers,
    input.actorUserId,
    input.memberId,
    input.role,
  );
  if (initialReason || !initialTarget || !fromRole) {
    const reason = initialReason ?? "not_found";
    auditFailure(
      db,
      input,
      "membership.role_changed",
      "member",
      input.memberId,
      reason,
      metadata,
    );
    return reason;
  }
  if (fromRole === input.role) {
    audit.append({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "membership.role_changed",
      targetType: "member",
      targetId: input.memberId,
      outcome: "succeeded",
      requestId: input.requestId,
      metadata,
    });
    return "unchanged";
  }

  const result = db.transaction(() => {
    const members = membersForOrganization(db, input.orgId);
    const target = members.find((member) => member.id === input.memberId);
    const reason = memberMutationReason(
      members,
      input.actorUserId,
      input.memberId,
      input.role,
    );
    if (reason || !target) return reason ?? "not_found";
    if (effectiveRole(target) !== fromRole) return "conflict";

    db.query(
      "UPDATE member SET role = ? WHERE id = ? AND organizationId = ?",
    ).run(input.role, input.memberId, input.orgId);
    appendOrganizationAuditEvent(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "membership.role_changed",
      targetType: "member",
      targetId: input.memberId,
      outcome: "succeeded",
      requestId: input.requestId,
      metadata,
    });
    return "changed";
  })();

  if (result !== "changed") {
    auditFailure(
      db,
      input,
      "membership.role_changed",
      "member",
      input.memberId,
      result,
      metadata,
    );
  }
  return result;
}

function validateWraps(
  members: MemberRecord[],
  wraps: OrganizationKeyWrap[],
  removeMemberId: string | undefined,
) {
  const expected = new Set(
    members
      .filter(
        (member) => member.publicKey !== null && member.id !== removeMemberId,
      )
      .map((member) => member.id),
  );
  const received = new Set(wraps.map((wrap) => wrap.memberId));
  return (
    received.size === wraps.length &&
    received.size === expected.size &&
    [...received].every((memberId) => expected.has(memberId))
  );
}

export function rotateOrganizationKey(db: Database, input: RotateKeyInput) {
  const audit = createOrganizationAuditStore(db);
  const generationMetadata = { generation: input.keyGeneration };
  audit.append({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action: "encryption.generation_changed",
    targetType: "encryption",
    targetId: input.orgId,
    outcome: "intent",
    requestId: input.requestId,
    metadata: generationMetadata,
  });
  if (input.removeMemberId) {
    audit.append({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "membership.removed",
      targetType: "member",
      targetId: input.removeMemberId,
      outcome: "intent",
      requestId: input.requestId,
      metadata: generationMetadata,
    });
  }
  const fail = (reason: string) => {
    auditFailure(
      db,
      input,
      "encryption.generation_changed",
      "encryption",
      input.orgId,
      reason,
      generationMetadata,
    );
    if (input.removeMemberId) {
      auditFailure(
        db,
        input,
        "membership.removed",
        "member",
        input.removeMemberId,
        reason,
        generationMetadata,
      );
    }
    return reason;
  };

  const initialMembers = membersForOrganization(db, input.orgId);
  const initialActor = initialMembers.find(
    (member) => member.userId === input.actorUserId,
  );
  if (!initialActor || initialActor.wrappedOrgKey === null) {
    return fail("forbidden");
  }
  if (input.removeMemberId) {
    const reason = memberMutationReason(
      initialMembers,
      input.actorUserId,
      input.removeMemberId,
    );
    if (reason) return fail(reason);
  }
  if (!validateWraps(initialMembers, input.wraps, input.removeMemberId)) {
    return fail("invalid_wraps");
  }

  const result = db.transaction(() => {
    const organization = db
      .query<OrganizationKeyRecord, [string]>(
        "SELECT keyGeneration, recoveryPublicKey FROM organization WHERE id = ?",
      )
      .get(input.orgId);
    if (!organization) return "not_found";
    const currentGeneration = organization.keyGeneration ?? 0;
    if (input.keyGeneration !== currentGeneration + 1) return "conflict";
    if (
      organization.recoveryPublicKey !== null &&
      (!input.recovery ||
        input.recovery.recoveryPublicKey !== organization.recoveryPublicKey)
    ) {
      return "recovery_required";
    }

    const members = membersForOrganization(db, input.orgId);
    const actor = members.find((member) => member.userId === input.actorUserId);
    if (!actor || actor.wrappedOrgKey === null) return "forbidden";
    if (input.removeMemberId) {
      const reason = memberMutationReason(
        members,
        input.actorUserId,
        input.removeMemberId,
      );
      if (reason) return reason;
    }
    if (!validateWraps(members, input.wraps, input.removeMemberId)) {
      return "invalid_wraps";
    }

    db.query(
      "UPDATE member SET wrappedOrgKey = NULL WHERE organizationId = ?",
    ).run(input.orgId);
    for (const wrap of input.wraps) {
      db.query(
        "UPDATE member SET wrappedOrgKey = ? WHERE id = ? AND organizationId = ?",
      ).run(wrap.wrappedOrgKey, wrap.memberId, input.orgId);
    }
    if (input.recovery) {
      db.query(
        "UPDATE organization SET keyGeneration = ?, recoveryPublicKey = ?, wrappedRecoveryKey = ? WHERE id = ?",
      ).run(
        input.keyGeneration,
        input.recovery.recoveryPublicKey,
        input.recovery.wrappedRecoveryKey,
        input.orgId,
      );
    } else {
      db.query("UPDATE organization SET keyGeneration = ? WHERE id = ?").run(
        input.keyGeneration,
        input.orgId,
      );
    }
    appendOrganizationAuditEvent(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "encryption.generation_changed",
      targetType: "encryption",
      targetId: input.orgId,
      outcome: "succeeded",
      requestId: input.requestId,
      metadata: { generation: input.keyGeneration, count: input.wraps.length },
    });
    if (input.removeMemberId) {
      db.query("DELETE FROM member WHERE id = ? AND organizationId = ?").run(
        input.removeMemberId,
        input.orgId,
      );
      appendOrganizationAuditEvent(db, {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: "membership.removed",
        targetType: "member",
        targetId: input.removeMemberId,
        outcome: "succeeded",
        requestId: input.requestId,
        metadata: { generation: input.keyGeneration },
      });
    }
    return "rotated";
  })();

  if (result !== "rotated") {
    return fail(result);
  }
  return result;
}
