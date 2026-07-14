import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { migrateOrganizationAudit } from "../audit/store";
import { buildAuthOptions } from "./instance";
import {
  createOrganizationInvitation,
  type InvitationMutationInput,
  listOrganizationMembers,
  reissueOrganizationInvitation,
  revokeOrganizationInvitation,
} from "./organization-members";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

function cookieFrom(response: { headers: Headers }) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function seededAuth() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  migrateOrganizationAudit(db);
  const auth = betterAuth(options);
  const owner = await auth.api.signUpEmail({
    body: {
      name: "Owner",
      email: "owner@example.test",
      password: "owner-password-123",
      publicKey: "public-owner",
    },
    returnHeaders: true,
  });
  const cookie = cookieFrom(owner);
  const organization = await auth.api.createOrganization({
    body: { name: "First Org", slug: "first-org" },
    headers: new Headers({ cookie }),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: organization.id },
    headers: new Headers({ cookie }),
  });
  db.query("UPDATE member SET wrappedOrgKey = ? WHERE userId = ?").run(
    "wrapped-owner",
    owner.response.user.id,
  );
  return {
    auth,
    cookie,
    db,
    orgId: organization.id,
    ownerId: owner.response.user.id,
  };
}

describe("organization member directory", () => {
  test("returns bounded org-scoped readiness projections with independent cursors", async () => {
    const { auth, db, orgId, ownerId } = await seededAuth();
    const pending = await auth.api.signUpEmail({
      body: {
        name: "Pending Member",
        email: "pending@example.test",
        password: "pending-password-123",
        publicKey: "public-pending-never-render",
      },
    });
    const unregistered = await auth.api.signUpEmail({
      body: {
        name: "Unregistered Member",
        email: "unregistered@example.test",
        password: "unregistered-password-123",
      },
    });
    db.query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('member-pending', ?, ?, 'member', '2026-07-13T02:00:00.000Z'),
              ('member-unregistered', ?, ?, 'admin', '2026-07-13T01:00:00.000Z')`,
    ).run(orgId, pending.user.id, orgId, unregistered.user.id);
    db.query(
      `INSERT INTO organization (id, name, slug, createdAt, keyGeneration)
       VALUES ('other-org', 'Other', 'other-org', '2026-07-13T00:00:00.000Z', 99)`,
    ).run();
    db.query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('other-member', 'other-org', ?, 'owner', '2026-07-13T03:00:00.000Z')`,
    ).run(unregistered.user.id);
    db.query(
      `INSERT INTO invitation
        (id, organizationId, email, role, status, expiresAt, inviterId, createdAt)
       VALUES ('invite-visible', ?, 'invite@example.test', 'member', 'pending',
               '2026-08-01T00:00:00.000Z', ?, '2026-07-13T03:00:00.000Z'),
              ('invite-other', 'other-org', 'other@example.test', 'owner', 'pending',
               '2026-08-01T00:00:00.000Z', ?, '2026-07-13T04:00:00.000Z')`,
    ).run(orgId, ownerId, ownerId);

    const first = listOrganizationMembers(
      db,
      orgId,
      { limit: 1 },
      () => new Date("2026-07-14T00:00:00.000Z"),
    );
    if (!first) throw new Error("missing directory page");
    expect(first.members).toHaveLength(1);
    expect(first.nextMemberCursor).toBeString();
    expect(first.invitations).toEqual([
      {
        email: "invite@example.test",
        role: "member",
        inviter: "Owner",
        createdAt: "2026-07-13T03:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        status: "pending",
      },
    ]);
    expect(JSON.stringify(first)).not.toContain("invite-visible");
    expect(JSON.stringify(first)).not.toContain("public-pending-never-render");
    expect(JSON.stringify(first)).not.toContain("wrapped-owner");
    expect(JSON.stringify(first)).not.toContain("other@example.test");

    const pendingOnly = listOrganizationMembers(db, orgId, {
      readiness: "pending",
      query: "pending@",
    });
    expect(pendingOnly?.members.map((member) => member.id)).toEqual([
      "member-pending",
    ]);

    const next = listOrganizationMembers(db, orgId, {
      limit: 1,
      memberCursor: first.nextMemberCursor ?? undefined,
    });
    expect(next?.members[0]?.id).not.toBe(first.members[0]?.id);
  });
});

describe("Better Auth invitation mutations", () => {
  test("creates, invalidates on reissue, revokes, and audits without tokens or email", async () => {
    const { auth, cookie, db, orgId, ownerId } = await seededAuth();
    const headers = new Headers({ cookie });
    const base = {
      orgId,
      actorUserId: ownerId,
      actorRole: "owner",
      email: "invitee@example.test",
      requestId: "request-invite",
      recentAuthentication: true,
    } satisfies InvitationMutationInput;

    expect(
      await createOrganizationInvitation(
        db,
        auth,
        { ...base, role: "admin" },
        headers,
      ),
    ).toBe("created");
    const original = db
      .query<{ id: string }, []>(
        "SELECT id FROM invitation WHERE status = 'pending'",
      )
      .get();
    if (!original) throw new Error("missing invitation");

    expect(
      await reissueOrganizationInvitation(
        db,
        auth,
        { ...base, requestId: "request-reissue" },
        headers,
      ),
    ).toBe("reissued");
    const invitations = db
      .query<{ id: string; status: string }, []>(
        "SELECT id, status FROM invitation ORDER BY createdAt, id",
      )
      .all();
    expect(invitations.filter((invitation) => invitation.status === "pending"))
      .toHaveLength(1);
    expect(
      invitations.find((invitation) => invitation.id === original.id)?.status,
    ).toBe("canceled");

    expect(
      await revokeOrganizationInvitation(
        db,
        auth,
        { ...base, requestId: "request-revoke" },
        headers,
      ),
    ).toBe("revoked");
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM invitation WHERE status = 'pending'",
        )
        .get(),
    ).toEqual({ count: 0 });

    const audit = db
      .query<
        { action: string; outcome: string; target_id: string },
        []
      >(
        "SELECT action, outcome, target_id FROM organization_audit_event ORDER BY seq",
      )
      .all();
    expect(audit.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: "invitation.created", outcome: "intent" },
      { action: "invitation.created", outcome: "succeeded" },
      { action: "invitation.reissued", outcome: "intent" },
      { action: "invitation.reissued", outcome: "succeeded" },
      { action: "invitation.revoked", outcome: "intent" },
      { action: "invitation.revoked", outcome: "succeeded" },
    ]);
    expect(JSON.stringify(audit)).not.toContain("invitee@example.test");
    expect(JSON.stringify(audit)).not.toContain(original.id);
  });

  test("admins cannot create or reissue owner grants", async () => {
    const { auth, cookie, db, orgId, ownerId } = await seededAuth();
    const base = {
      orgId,
      actorUserId: ownerId,
      actorRole: "admin",
      email: "owner-invite@example.test",
      requestId: "request-admin-owner",
      recentAuthentication: true,
    } satisfies InvitationMutationInput;
    expect(
      await createOrganizationInvitation(
        db,
        auth,
        { ...base, role: "owner" },
        new Headers({ cookie }),
      ),
    ).toBe("forbidden");
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM invitation WHERE status = 'pending'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});
