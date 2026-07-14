import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import type {
  CreateInvitationInput,
  InvitationMutationInput,
  OrganizationInvitationSummary,
  OrganizationMemberFilters,
  OrganizationMemberSummary,
} from "../auth/organization-members";
import type { OrganizationMembersOptions } from "./members";

const ORIGIN = "https://mimir.test";
const NOW = Date.parse("2026-07-14T05:00:00.000Z");
const browserHeaders = {
  cookie: "better-auth.session_token=browser-session",
  origin: ORIGIN,
};

function directory(orgId: string, filters: OrganizationMemberFilters) {
  const suffix = orgId === "org-1" ? "one" : "two";
  return {
    keyGeneration: 3,
    members: [
      {
        id: `member-${suffix}`,
        userId: `user-${suffix}`,
        name: `Member ${suffix}`,
        email: `${suffix}@example.test`,
        role: "member",
        joinedAt: "2026-07-13T00:00:00.000Z",
        publicKeyRegistered: true,
        wrapAvailable: false,
        readiness: "pending",
      } satisfies OrganizationMemberSummary,
    ],
    invitations: [
      {
        email: `invited-${suffix}@example.test`,
        role: "admin",
        inviter: "Current Owner",
        createdAt: "2026-07-13T01:00:00.000Z",
        expiresAt: "2026-07-20T01:00:00.000Z",
        status: "pending",
      } satisfies OrganizationInvitationSummary,
    ],
    nextMemberCursor: filters.memberCursor ? null : "memberCursor",
    nextInvitationCursor: filters.invitationCursor ? null : "invitationCursor",
  };
}

function testApp(
  role: "owner" | "admin" = "owner",
  overrides: Partial<OrganizationMembersOptions> = {},
) {
  const sessionLookup = (headers: Headers) => {
    const orgId = headers.get("cookie")?.includes("org-2") ? "org-2" : "org-1";
    return Promise.resolve({
      user: { id: "actor-user" },
      session: { activeOrganizationId: orgId, createdAt: new Date(NOW) },
    });
  };
  const activeMemberLookup = (headers: Headers) => {
    const orgId = headers.get("cookie")?.includes("org-2") ? "org-2" : "org-1";
    return Promise.resolve({
      userId: "actor-user",
      organizationId: orgId,
      role,
    });
  };
  const options: OrganizationMembersOptions = {
    origin: ORIGIN,
    list: directory,
    invite: () => Promise.resolve("created"),
    revokeInvitation: () => Promise.resolve("revoked"),
    reissueInvitation: () => Promise.resolve("reissued"),
    request: () => Response.json({ ok: true }),
    now: () => NOW,
    ...overrides,
  };
  return createApp({
    authEnabled: true,
    sessionLookup,
    activeMemberLookup,
    organizationMembers: options,
  });
}

function postForm(
  app: ReturnType<typeof createApp>,
  path: string,
  values: Record<string, string>,
  origin = ORIGIN,
) {
  return app.request(path, {
    method: "POST",
    headers: {
      ...browserHeaders,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
}

describe("organization members page", () => {
  test("renders bounded readiness without invitation IDs or key material", async () => {
    let filters: OrganizationMemberFilters | undefined;
    const app = testApp("owner", {
      list: (orgId, value) => {
        filters = value;
        return directory(orgId, value);
      },
    });
    const response = await app.request(
      "/admin/members?q=one&role=member&readiness=pending&invitationStatus=pending",
      { headers: browserHeaders },
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(filters).toMatchObject({
      query: "one",
      role: "member",
      readiness: "pending",
      invitationStatus: "pending",
    });
    expect(html).toContain("Member one");
    expect(html).toContain("invited-one@example.test");
    expect(html).toContain("Pending key access");
    expect(html).toContain("Current organization generation: 3");
    expect(html).toContain('src="/assets/members.js"');
    expect(html).not.toContain("public-key-never-render");
    expect(html).not.toContain("wrapped-key-never-render");
    expect(html).not.toContain("invitation-token-never-render");
  });

  test("active organization switching re-scopes every read", async () => {
    const app = testApp();
    const first = await app.request("/admin/members", {
      headers: { ...browserHeaders, cookie: "active=org-1" },
    });
    const second = await app.request("/admin/members", {
      headers: { ...browserHeaders, cookie: "active=org-2" },
    });
    const firstHtml = await first.text();
    const secondHtml = await second.text();

    expect(firstHtml).toContain("Member one");
    expect(firstHtml).not.toContain("Member two");
    expect(secondHtml).toContain("Member two");
    expect(secondHtml).not.toContain("Member one");
  });

  test("admin controls omit owner grants and owner removal", async () => {
    const app = testApp("admin", {
      list: () => ({
        keyGeneration: 1,
        members: [
          {
            id: "member-owner",
            userId: "user-owner",
            name: "Protected Owner",
            email: "owner@example.test",
            role: "owner",
            joinedAt: "2026-07-13T00:00:00.000Z",
            publicKeyRegistered: true,
            wrapAvailable: true,
            readiness: "ready",
          },
        ],
        invitations: [],
        nextMemberCursor: null,
        nextInvitationCursor: null,
      }),
    });
    const html = await (
      await app.request("/admin/members", { headers: browserHeaders })
    ).text();

    const inviteRoles = html.match(
      /<select id="invite-role"[^>]*>[\s\S]*?<\/select>/,
    )?.[0];
    expect(inviteRoles).toBeDefined();
    expect(inviteRoles).not.toContain('<option value="owner"');
    expect(html).not.toContain("Confirm rotation-backed removal");
  });
});

describe("organization member forms", () => {
  test("trusted invite, reissue, revoke, and role forms carry scoped inputs", async () => {
    let invited: CreateInvitationInput | undefined;
    let revoked: InvitationMutationInput | undefined;
    let reissued: InvitationMutationInput | undefined;
    let roleBody = "";
    const app = testApp("owner", {
      invite: (input) => {
        invited = input;
        return Promise.resolve("created");
      },
      revokeInvitation: (input) => {
        revoked = input;
        return Promise.resolve("revoked");
      },
      reissueInvitation: (input) => {
        reissued = input;
        return Promise.resolve("reissued");
      },
      request: (_path, init) => {
        roleBody = typeof init.body === "string" ? init.body : "";
        return Response.json({ ok: true });
      },
    });

    expect(
      (
        await postForm(app, "/admin/members/invite", {
          email: "NEW@EXAMPLE.TEST",
          role: "owner",
        })
      ).status,
    ).toBe(303);
    expect(invited).toMatchObject({
      orgId: "org-1",
      actorUserId: "actor-user",
      actorRole: "owner",
      email: "new@example.test",
      role: "owner",
      recentAuthentication: true,
    });

    await postForm(app, "/admin/members/invitations/reissue", {
      email: "new@example.test",
    });
    await postForm(app, "/admin/members/invitations/revoke", {
      email: "new@example.test",
    });
    expect(reissued?.orgId).toBe("org-1");
    expect(revoked?.orgId).toBe("org-1");

    expect(
      (
        await postForm(app, "/admin/members/role", {
          memberId: "member-one",
          role: "admin",
        })
      ).status,
    ).toBe(303);
    expect(JSON.parse(roleBody)).toEqual({
      memberId: "member-one",
      role: "admin",
    });
  });

  test("untrusted origins fail generically before mutation", async () => {
    let mutations = 0;
    const app = testApp("owner", {
      invite: () => {
        mutations += 1;
        return Promise.resolve("created");
      },
    });
    const response = await postForm(
      app,
      "/admin/members/invite",
      { email: "new@example.test", role: "member" },
      "https://evil.test",
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(mutations).toBe(0);
    expect(html).toContain("could not be completed");
    expect(html).not.toContain("new@example.test");
  });

  test("raw Better Auth organization mutations cannot bypass application policy", async () => {
    let handlerCalls = 0;
    const app = createApp({
      authEnabled: true,
      authHandler: async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      },
      sessionLookup: () => Promise.resolve(null),
      activeMemberLookup: () => Promise.resolve(null),
      organizationMembers: {
        origin: ORIGIN,
        list: directory,
        invite: () => Promise.resolve("created"),
        revokeInvitation: () => Promise.resolve("revoked"),
        reissueInvitation: () => Promise.resolve("reissued"),
        request: () => Response.json({ ok: true }),
      },
    });

    for (const path of [
      "/api/auth/organization/invite-member",
      "/api/auth/organization/cancel-invitation",
      "/api/auth/organization/update-member-role",
      "/api/auth/organization/remove-member",
      "/api/auth/organization/leave",
    ]) {
      const response = await app.request(path, { method: "POST" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { message: "Forbidden" },
      });
    }
    expect(handlerCalls).toBe(0);
  });
});
