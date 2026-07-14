import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import type {
  OrganizationAuditFilters,
  OrganizationAuditMetadata,
} from "../audit/store";
import type { OrganizationAuditList } from "./activity";

const browserSession = { cookie: "better-auth.session_token=session-1" };

const sessionFor = (orgId: string) => () =>
  Promise.resolve({
    user: { id: "user-1" },
    session: { activeOrganizationId: orgId },
  });

const memberFor = (orgId: string, role: string) => () =>
  Promise.resolve({
    userId: "user-1",
    organizationId: orgId,
    role,
  });

function auditListFor(targetId: string, nextCursor: string | null = null) {
  const metadata: OrganizationAuditMetadata & { secret: string } = {
    field: "defaultInvitationRole",
    fromValue: "member",
    toValue: "admin",
    fromRole: "member",
    toRole: "admin",
    secret: "never-render-this-password",
  };
  const list: OrganizationAuditList = () => ({
    events: [
      {
        id: "event-1",
        actorUserId: "user-2",
        action: "membership.role_changed",
        targetType: "member",
        targetId,
        outcome: "succeeded",
        requestId: "request-1",
        metadata,
        createdAt: "2026-07-13T00:00:00.000Z",
        cursor: "MQ",
      },
    ],
    nextCursor,
    retentionDays: 365,
  });
  return list;
}

describe("organization activity view", () => {
  test("renders bounded active-organization events without a client runtime", async () => {
    let seenOrg = "";
    let seenFilters: OrganizationAuditFilters | undefined;
    const source = auditListFor("member-1", "MQ");
    const list: OrganizationAuditList = (orgId, filters) => {
      seenOrg = orgId;
      seenFilters = filters;
      return source(orgId, filters);
    };
    const response = await createApp({
      authEnabled: true,
      sessionLookup: sessionFor("org-1"),
      activeMemberLookup: memberFor("org-1", "owner"),
      organizationAuditList: list,
    }).request(
      "/admin/activity?action=membership.role_changed&actor=user-2&target=member&outcome=succeeded&from=2026-07-01",
      { headers: browserSession },
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(seenOrg).toBe("org-1");
    expect(seenFilters).toMatchObject({
      action: "membership.role_changed",
      actorUserId: "user-2",
      targetType: "member",
      outcome: "succeeded",
      fromDate: "2026-07-01",
      limit: 25,
    });
    expect(html).toContain("Organization activity — Mimir");
    expect(html).toContain("membership.role_changed");
    expect(html).toContain("member:member-1");
    expect(html).toContain("Previous role");
    expect(html).toContain("New role");
    expect(html).toContain("Previous value");
    expect(html).toContain("New value");
    expect(html).toContain("Older activity");
    expect(html).not.toContain("never-render-this-password");
    expect(html).not.toContain("<script");
  });

  test("ordinary members, API keys, and signed-out browsers never reach the reader", async () => {
    let reads = 0;
    const list: OrganizationAuditList = () => {
      reads += 1;
      return { events: [], nextCursor: null, retentionDays: 365 };
    };
    const memberApp = createApp({
      authEnabled: true,
      sessionLookup: sessionFor("org-1"),
      activeMemberLookup: memberFor("org-1", "member"),
      organizationAuditList: list,
    });
    const signedOut = createApp({
      authEnabled: true,
      sessionLookup: () => Promise.resolve(null),
      activeMemberLookup: memberFor("org-1", "owner"),
      organizationAuditList: list,
    });

    expect(
      (await memberApp.request("/admin/activity", { headers: browserSession }))
        .status,
    ).toBe(403);
    expect(
      (
        await memberApp.request("/admin/activity", {
          headers: { authorization: "Bearer tenant-api-key" },
        })
      ).status,
    ).toBe(403);
    expect((await signedOut.request("/admin/activity")).status).toBe(302);
    expect(reads).toBe(0);
  });

  test("organization switching re-scopes every read", async () => {
    const sessionLookup = (headers: Headers) => {
      const orgId = headers.get("cookie")?.includes("org-2")
        ? "org-2"
        : "org-1";
      return sessionFor(orgId)();
    };
    const activeMemberLookup = (headers: Headers) => {
      const orgId = headers.get("cookie")?.includes("org-2")
        ? "org-2"
        : "org-1";
      return memberFor(orgId, "owner")();
    };
    const list: OrganizationAuditList = (orgId) =>
      auditListFor(`${orgId}-member`)(orgId);
    const app = createApp({
      authEnabled: true,
      sessionLookup,
      activeMemberLookup,
      organizationAuditList: list,
    });
    const first = await app.request("/admin/activity", {
      headers: { cookie: "active=org-1" },
    });
    const second = await app.request("/admin/activity", {
      headers: { cookie: "active=org-2" },
    });
    const firstHtml = await first.text();
    const secondHtml = await second.text();

    expect(firstHtml).toContain("org-1-member");
    expect(firstHtml).not.toContain("org-2-member");
    expect(secondHtml).toContain("org-2-member");
    expect(secondHtml).not.toContain("org-1-member");
  });

  test("malformed filters and reader failures stay detail-free", async () => {
    let reads = 0;
    const invalidApp = createApp({
      authEnabled: true,
      sessionLookup: sessionFor("org-1"),
      activeMemberLookup: memberFor("org-1", "owner"),
      organizationAuditList: () => {
        reads += 1;
        return { events: [], nextCursor: null, retentionDays: 365 };
      },
    });
    const failedApp = createApp({
      authEnabled: true,
      sessionLookup: sessionFor("org-1"),
      activeMemberLookup: memberFor("org-1", "owner"),
      organizationAuditList: () => {
        throw new Error("database path and secret must stay hidden");
      },
    });
    const invalid = await invalidApp.request(
      "/admin/activity?actor=person@example.test",
      { headers: browserSession },
    );
    const failed = await failedApp.request("/admin/activity", {
      headers: browserSession,
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toBe("Bad request");
    expect(reads).toBe(0);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("Unavailable");
  });
});
