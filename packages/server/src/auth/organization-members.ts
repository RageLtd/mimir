import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createOrganizationAuditStore } from "../audit/store";
import { attempt, attemptSync } from "../util/result";
import type { getAuth } from "./instance";
import type { OrganizationRole } from "./membership";

export type MemberReadiness = "ready" | "pending" | "unregistered";

export interface OrganizationMemberFilters {
  query?: string;
  role?: OrganizationRole;
  readiness?: MemberReadiness;
  memberCursor?: string;
  invitationCursor?: string;
  invitationStatus?: "pending" | "expired";
  limit?: number;
}

export interface OrganizationMemberSummary {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  joinedAt: string;
  publicKeyRegistered: boolean;
  wrapAvailable: boolean;
  readiness: MemberReadiness;
}

export interface OrganizationInvitationSummary {
  email: string;
  role: OrganizationRole;
  inviter: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "expired";
}

interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  publicKey: string | null;
  wrappedOrgKey: string | null;
}

interface InvitationRow {
  email: string;
  role: string;
  inviter: string;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationMutationInput {
  orgId: string;
  actorUserId: string;
  actorRole: OrganizationRole;
  email: string;
  requestId: string;
  recentAuthentication: boolean;
}

export interface CreateInvitationInput extends InvitationMutationInput {
  role: OrganizationRole;
}

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_QUERY_LENGTH = 100;

function boundedLimit(value: number | undefined) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
}

function readRole(value: string): OrganizationRole {
  const roles = new Set(value.split(",").map((role) => role.trim()));
  if (roles.has("owner")) return "owner";
  if (roles.has("admin")) return "admin";
  return "member";
}

function readiness(row: MemberRow): MemberReadiness {
  if (!row.publicKey) return "unregistered";
  return row.wrappedOrgKey ? "ready" : "pending";
}

function encodeCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

function decodeCursor(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  const [error, parsed] = attemptSync(() =>
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  );
  if (
    error ||
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    return null;
  }
  return { createdAt: parsed[0], id: parsed[1] };
}

function escapeLike(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function memberRows(
  db: Database,
  orgId: string,
  filters: OrganizationMemberFilters,
) {
  const clauses = ["m.organizationId = ?"];
  const bindings: Array<string | number> = [orgId];
  const query = filters.query?.trim().slice(0, MAX_QUERY_LENGTH);
  if (query) {
    clauses.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(query)}%`;
    bindings.push(like, like);
  }
  if (filters.role) {
    clauses.push("m.role = ?");
    bindings.push(filters.role);
  }
  if (filters.readiness === "ready") {
    clauses.push("u.publicKey IS NOT NULL AND m.wrappedOrgKey IS NOT NULL");
  } else if (filters.readiness === "pending") {
    clauses.push("u.publicKey IS NOT NULL AND m.wrappedOrgKey IS NULL");
  } else if (filters.readiness === "unregistered") {
    clauses.push("u.publicKey IS NULL");
  }
  const cursor = decodeCursor(filters.memberCursor);
  if (filters.memberCursor && !cursor) return null;
  if (cursor) {
    clauses.push("(m.createdAt < ? OR (m.createdAt = ? AND m.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const limit = boundedLimit(filters.limit);
  bindings.push(limit + 1);
  const rows = db
    .query<MemberRow, Array<string | number>>(
      `SELECT m.id, m.userId, u.name, u.email, m.role,
              m.createdAt, u.publicKey, m.wrappedOrgKey
         FROM member m JOIN "user" u ON u.id = m.userId
        WHERE ${clauses.join(" AND ")}
        ORDER BY m.createdAt DESC, m.id DESC
        LIMIT ?`,
    )
    .all(...bindings);
  return { rows, limit };
}

function invitationRows(
  db: Database,
  orgId: string,
  filters: OrganizationMemberFilters,
  now: Date,
) {
  const clauses = ["i.organizationId = ?", "i.status = 'pending'"];
  const bindings: Array<string | number> = [orgId];
  const query = filters.query?.trim().slice(0, MAX_QUERY_LENGTH);
  if (query) {
    clauses.push(
      "(i.email LIKE ? ESCAPE '\\' OR inviter.name LIKE ? ESCAPE '\\')",
    );
    const like = `%${escapeLike(query)}%`;
    bindings.push(like, like);
  }
  if (filters.role) {
    clauses.push("i.role = ?");
    bindings.push(filters.role);
  }
  if (filters.invitationStatus === "pending") {
    clauses.push("i.expiresAt > ?");
    bindings.push(now.toISOString());
  } else if (filters.invitationStatus === "expired") {
    clauses.push("i.expiresAt <= ?");
    bindings.push(now.toISOString());
  }
  const cursor = decodeCursor(filters.invitationCursor);
  if (filters.invitationCursor && !cursor) return null;
  if (cursor) {
    clauses.push("(i.createdAt < ? OR (i.createdAt = ? AND i.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const limit = boundedLimit(filters.limit);
  bindings.push(limit + 1);
  const rows = db
    .query<InvitationRow & { id: string }, Array<string | number>>(
      `SELECT i.id, i.email, i.role, inviter.name AS inviter,
              i.createdAt, i.expiresAt
         FROM invitation i JOIN "user" inviter ON inviter.id = i.inviterId
        WHERE ${clauses.join(" AND ")}
        ORDER BY i.createdAt DESC, i.id DESC
        LIMIT ?`,
    )
    .all(...bindings);
  return { rows, limit };
}

export function listOrganizationMembers(
  db: Database,
  orgId: string,
  filters: OrganizationMemberFilters = {},
  now: () => Date = () => new Date(),
) {
  const organization = db
    .query<{ keyGeneration: number | null }, [string]>(
      "SELECT keyGeneration FROM organization WHERE id = ?",
    )
    .get(orgId);
  if (!organization) return null;
  const current = now();
  const memberPage = memberRows(db, orgId, filters);
  const invitationPage = invitationRows(db, orgId, filters, current);
  if (!memberPage || !invitationPage) return null;
  const members = memberPage.rows.slice(0, memberPage.limit).map(
    (row) =>
      ({
        id: row.id,
        userId: row.userId,
        name: row.name,
        email: row.email,
        role: readRole(row.role),
        joinedAt: row.createdAt,
        publicKeyRegistered: row.publicKey !== null,
        wrapAvailable: row.wrappedOrgKey !== null,
        readiness: readiness(row),
      }) satisfies OrganizationMemberSummary,
  );
  const invitations = invitationPage.rows.slice(0, invitationPage.limit).map(
    (row) =>
      ({
        email: row.email,
        role: readRole(row.role),
        inviter: row.inviter,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        status: new Date(row.expiresAt) <= current ? "expired" : "pending",
      }) satisfies OrganizationInvitationSummary,
  );
  const lastMember = members.at(-1);
  const lastInvitation = invitationPage.rows
    .slice(0, invitationPage.limit)
    .at(-1);
  return {
    keyGeneration: organization.keyGeneration,
    members,
    invitations,
    nextMemberCursor:
      memberPage.rows.length > memberPage.limit && lastMember
        ? encodeCursor(lastMember.joinedAt, lastMember.id)
        : null,
    nextInvitationCursor:
      invitationPage.rows.length > invitationPage.limit && lastInvitation
        ? encodeCursor(lastInvitation.createdAt, lastInvitation.id)
        : null,
  };
}

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

export function organizationInvitationTarget(orgId: string, email: string) {
  const digest = createHash("sha256")
    .update(orgId)
    .update("\0")
    .update(normalizedEmail(email))
    .digest("base64url")
    .slice(0, 32);
  return `invitation:${digest}`;
}

function canInvite(actorRole: OrganizationRole, role: OrganizationRole) {
  return actorRole === "owner" || (actorRole === "admin" && role !== "owner");
}

function invitationAudit(
  db: Database,
  input: InvitationMutationInput,
  action: "invitation.created" | "invitation.revoked" | "invitation.reissued",
  outcome: "intent" | "succeeded" | "failed",
  reasonCode?: "validation" | "unauthorized" | "conflict" | "dependency",
) {
  createOrganizationAuditStore(db).append({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action,
    targetType: "invitation",
    targetId: organizationInvitationTarget(input.orgId, input.email),
    outcome,
    requestId: input.requestId,
    metadata: reasonCode ? { reasonCode } : {},
  });
}

function pendingInvitations(db: Database, orgId: string, email: string) {
  return db
    .query<{ id: string; role: string }, [string, string]>(
      `SELECT id, role FROM invitation
        WHERE organizationId = ? AND lower(email) = ? AND status = 'pending'
        ORDER BY createdAt DESC, id DESC`,
    )
    .all(orgId, normalizedEmail(email));
}

async function cancelPendingInvitations(
  db: Database,
  auth: ReturnType<typeof getAuth>,
  input: InvitationMutationInput,
  headers: Headers,
) {
  const invitations = pendingInvitations(db, input.orgId, input.email);
  if (invitations.length === 0) return "not_found";
  for (const invitation of invitations) {
    const [error] = await attempt(() =>
      auth.api.cancelInvitation({
        body: { invitationId: invitation.id },
        headers,
      }),
    );
    if (error) return "dependency";
  }
  return "cancelled";
}

export async function createOrganizationInvitation(
  db: Database,
  auth: ReturnType<typeof getAuth>,
  input: CreateInvitationInput,
  headers: Headers,
) {
  invitationAudit(db, input, "invitation.created", "intent");
  if (
    !canInvite(input.actorRole, input.role) ||
    (input.role === "owner" && !input.recentAuthentication)
  ) {
    invitationAudit(db, input, "invitation.created", "failed", "unauthorized");
    return "forbidden";
  }
  const [error] = await attempt(() =>
    auth.api.createInvitation({
      body: {
        email: normalizedEmail(input.email),
        role: input.role,
        organizationId: input.orgId,
      },
      headers,
    }),
  );
  if (error) {
    invitationAudit(db, input, "invitation.created", "failed", "dependency");
    return "failed";
  }
  invitationAudit(db, input, "invitation.created", "succeeded");
  return "created";
}

export async function revokeOrganizationInvitation(
  db: Database,
  auth: ReturnType<typeof getAuth>,
  input: InvitationMutationInput,
  headers: Headers,
) {
  invitationAudit(db, input, "invitation.revoked", "intent");
  const existing = pendingInvitations(db, input.orgId, input.email)[0];
  if (!existing || !canInvite(input.actorRole, readRole(existing.role))) {
    invitationAudit(
      db,
      input,
      "invitation.revoked",
      "failed",
      existing ? "unauthorized" : "validation",
    );
    return existing ? "forbidden" : "not_found";
  }
  const result = await cancelPendingInvitations(db, auth, input, headers);
  if (result !== "cancelled") {
    invitationAudit(db, input, "invitation.revoked", "failed", "dependency");
    return "failed";
  }
  invitationAudit(db, input, "invitation.revoked", "succeeded");
  return "revoked";
}

export async function reissueOrganizationInvitation(
  db: Database,
  auth: ReturnType<typeof getAuth>,
  input: InvitationMutationInput,
  headers: Headers,
) {
  invitationAudit(db, input, "invitation.reissued", "intent");
  const existing = pendingInvitations(db, input.orgId, input.email)[0];
  if (
    !existing ||
    !canInvite(input.actorRole, readRole(existing.role)) ||
    (readRole(existing.role) === "owner" && !input.recentAuthentication)
  ) {
    invitationAudit(
      db,
      input,
      "invitation.reissued",
      "failed",
      existing ? "unauthorized" : "validation",
    );
    return existing ? "forbidden" : "not_found";
  }
  const cancelled = await cancelPendingInvitations(db, auth, input, headers);
  if (cancelled !== "cancelled") {
    invitationAudit(db, input, "invitation.reissued", "failed", "dependency");
    return "failed";
  }
  const [error] = await attempt(() =>
    auth.api.createInvitation({
      body: {
        email: normalizedEmail(input.email),
        role: readRole(existing.role),
        organizationId: input.orgId,
      },
      headers,
    }),
  );
  if (error) {
    invitationAudit(db, input, "invitation.reissued", "failed", "dependency");
    return "failed";
  }
  invitationAudit(db, input, "invitation.reissued", "succeeded");
  return "reissued";
}
