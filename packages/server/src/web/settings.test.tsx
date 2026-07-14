import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import type {
  CancelOrganizationDeletionInput,
  ScheduleOrganizationDeletionInput,
} from "../auth/organization-lifecycle";
import type {
  UpdateOrganizationNameInput,
  UpdateOrganizationPolicyInput,
  UpdateOrganizationSlugInput,
} from "../auth/organization-settings";
import type { OrganizationSettingsOptions } from "./settings";

const ORIGIN = "https://mimir.test";
const NOW = Date.parse("2026-07-14T06:00:00.000Z");
const browserHeaders = {
  cookie: "better-auth.session_token=browser-session",
  origin: ORIGIN,
};

function settings(orgId: string) {
  const second = orgId === "org-2";
  return {
    id: orgId,
    name: second ? "Second Org" : "First Org",
    slug: second ? "second-org" : "first-org",
    defaultInvitationRole: "member" as const,
    invitationLifetimeDays: 2,
    auditRetentionDays: 365,
    policyVersion: 0,
    keyGeneration: second ? null : 4,
    recoveryReady: !second,
  };
}

function lifecycle() {
  return {
    ownerCount: 2,
    keyedOwnerCount: 2,
    deletion: null,
  };
}

function testApp(
  role: "owner" | "admin" | "member" = "owner",
  overrides: Partial<OrganizationSettingsOptions> = {},
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
  const organizationSettings: OrganizationSettingsOptions = {
    origin: ORIGIN,
    read: settings,
    updateName: () => Promise.resolve("updated"),
    updateSlug: () => Promise.resolve("updated"),
    updatePolicy: () => "updated",
    readLifecycle: lifecycle,
    scheduleDeletion: () => "scheduled",
    cancelDeletion: () => "cancelled",
    now: () => NOW,
    ...overrides,
  };
  return createApp({
    authEnabled: true,
    sessionLookup,
    activeMemberLookup,
    organizationSettings,
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

describe("organization settings page", () => {
  test("renders bounded settings and read-only security status without JavaScript", async () => {
    const response = await testApp().request("/admin/settings", {
      headers: browserHeaders,
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain("Organization settings — Mimir");
    expect(html).toContain('value="First Org"');
    expect(html).toContain('value="first-org"');
    expect(html).toContain("org-1");
    expect(html).toContain("Key generation</dt><dd>4");
    expect(html).toContain("Recovery configured");
    expect(html).not.toContain("recovery-public");
    expect(html).not.toContain("wrapped-key");
    expect(html).toContain("2 owners");
    expect(html).toContain('href="/admin/memories"');
    expect(html).toContain('action="/admin/settings/deletion/schedule"');
    expect(html).not.toContain("<script");
  });

  test("admins can edit display name but never receive owner-only controls", async () => {
    const html = await (
      await testApp("admin").request("/admin/settings", {
        headers: browserHeaders,
      })
    ).text();

    expect(html).toContain('action="/admin/settings/name"');
    expect(html).not.toContain('action="/admin/settings/slug"');
    expect(html).not.toContain('action="/admin/settings/policy"');
    expect(html).not.toContain("Ownership &amp; deletion");
    expect(html).not.toContain('action="/admin/settings/deletion/schedule"');
  });

  test("shows the bounded grace period and cancellation control", async () => {
    const html = await (
      await testApp("owner", {
        readLifecycle: () => ({
          ownerCount: 1,
          keyedOwnerCount: 1,
          deletion: {
            scheduleId: "schedule:one",
            scheduledAt: "2026-07-14T06:00:00.000Z",
            purgeAfter: "2026-07-21T06:00:00.000Z",
            status: "scheduled",
          },
        }),
      }).request("/admin/settings", { headers: browserHeaders })
    ).text();

    expect(html).toContain("2026-07-21 06:00:00 UTC");
    expect(html).toContain('value="schedule:one"');
    expect(html).toContain('action="/admin/settings/deletion/cancel"');
    expect(html).not.toContain('action="/admin/settings/deletion/schedule"');
  });

  test("active organization switching re-scopes every read", async () => {
    const app = testApp();
    const first = await app.request("/admin/settings", {
      headers: { ...browserHeaders, cookie: "active=org-1" },
    });
    const second = await app.request("/admin/settings", {
      headers: { ...browserHeaders, cookie: "active=org-2" },
    });

    expect(await first.text()).toContain("First Org");
    expect(await second.text()).toContain("Second Org");
  });
});

describe("organization settings forms", () => {
  test("trusted forms derive organization, actor, and recent authentication", async () => {
    let nameInput: UpdateOrganizationNameInput | undefined;
    let slugInput: UpdateOrganizationSlugInput | undefined;
    let policyInput: UpdateOrganizationPolicyInput | undefined;
    let scheduleInput: ScheduleOrganizationDeletionInput | undefined;
    let cancelInput: CancelOrganizationDeletionInput | undefined;
    const app = testApp("owner", {
      updateName: (input) => {
        nameInput = input;
        return Promise.resolve("updated");
      },
      updateSlug: (input) => {
        slugInput = input;
        return Promise.resolve("updated");
      },
      updatePolicy: (input) => {
        policyInput = input;
        return "updated";
      },
      scheduleDeletion: (input) => {
        scheduleInput = input;
        return "scheduled";
      },
      cancelDeletion: (input) => {
        cancelInput = input;
        return "cancelled";
      },
    });

    expect(
      (
        await postForm(app, "/admin/settings/name", {
          expectedName: "First Org",
          name: "Renamed Org",
        })
      ).status,
    ).toBe(303);
    expect(nameInput).toMatchObject({
      orgId: "org-1",
      actorUserId: "actor-user",
      expectedName: "First Org",
      name: "Renamed Org",
    });

    await postForm(app, "/admin/settings/slug", {
      expectedSlug: "first-org",
      slug: "renamed-org",
    });
    expect(slugInput).toMatchObject({
      orgId: "org-1",
      actorUserId: "actor-user",
      recentAuthentication: true,
    });

    await postForm(app, "/admin/settings/policy", {
      expectedVersion: "0",
      defaultInvitationRole: "admin",
      invitationLifetimeDays: "7",
      auditRetentionDays: "180",
    });
    expect(policyInput).toMatchObject({
      orgId: "org-1",
      actorUserId: "actor-user",
      expectedVersion: 0,
      defaultInvitationRole: "admin",
      invitationLifetimeDays: 7,
      auditRetentionDays: 180,
      recentAuthentication: true,
    });

    expect(
      (
        await postForm(app, "/admin/settings/deletion/schedule", {
          confirmation: "First Org",
        })
      ).status,
    ).toBe(303);
    expect(scheduleInput).toMatchObject({
      orgId: "org-1",
      actorUserId: "actor-user",
      confirmation: "First Org",
      recentAuthentication: true,
    });

    expect(
      (
        await postForm(app, "/admin/settings/deletion/cancel", {
          scheduleId: "schedule:one",
        })
      ).status,
    ).toBe(303);
    expect(cancelInput).toMatchObject({
      orgId: "org-1",
      actorUserId: "actor-user",
      scheduleId: "schedule:one",
      recentAuthentication: true,
    });
  });

  test("untrusted origins and forged admin owner mutations fail before handlers", async () => {
    let mutations = 0;
    const owner = testApp("owner", {
      updateName: () => {
        mutations += 1;
        return Promise.resolve("updated");
      },
      scheduleDeletion: () => {
        mutations += 1;
        return "scheduled";
      },
    });
    const admin = testApp("admin", {
      updateSlug: () => {
        mutations += 1;
        return Promise.resolve("updated");
      },
      updatePolicy: () => {
        mutations += 1;
        return "updated";
      },
      scheduleDeletion: () => {
        mutations += 1;
        return "scheduled";
      },
    });

    expect(
      (
        await postForm(
          owner,
          "/admin/settings/name",
          { expectedName: "First Org", name: "Attacker" },
          "https://evil.test",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await postForm(
          owner,
          "/admin/settings/deletion/schedule",
          { confirmation: "First Org" },
          "https://evil.test",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await postForm(admin, "/admin/settings/slug", {
          expectedSlug: "first-org",
          slug: "forged-slug",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postForm(admin, "/admin/settings/policy", {
          expectedVersion: "0",
          defaultInvitationRole: "admin",
          invitationLifetimeDays: "7",
          auditRetentionDays: "180",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postForm(admin, "/admin/settings/deletion/schedule", {
          confirmation: "First Org",
        })
      ).status,
    ).toBe(400);
    expect(mutations).toBe(0);
  });

  test("owner-only changes carry stale authentication to the enforcing store", async () => {
    let recentAuthentication = true;
    const app = testApp("owner", {
      now: () => NOW + 11 * 60 * 1000,
      updateSlug: (input) => {
        recentAuthentication = input.recentAuthentication;
        return Promise.resolve("forbidden");
      },
      scheduleDeletion: (input) => {
        recentAuthentication = input.recentAuthentication;
        return "forbidden";
      },
    });
    const response = await postForm(app, "/admin/settings/slug", {
      expectedSlug: "first-org",
      slug: "renamed-org",
    });

    expect(response.status).toBe(400);
    expect(recentAuthentication).toBe(false);
    expect(await response.text()).toContain("could not be completed");

    const deletionResponse = await postForm(
      app,
      "/admin/settings/deletion/schedule",
      { confirmation: "First Org" },
    );
    expect(deletionResponse.status).toBe(400);
    expect(recentAuthentication).toBe(false);
  });

  test("members, signed-out browsers, API keys, and auth-off deployments cannot mutate", async () => {
    let mutations = 0;
    const app = testApp("member", {
      updateName: () => {
        mutations += 1;
        return Promise.resolve("updated");
      },
    });
    const values = new URLSearchParams({
      expectedName: "First Org",
      name: "Forbidden Org",
    });

    expect(
      (
        await app.request("/admin/settings/name", {
          method: "POST",
          headers: {
            ...browserHeaders,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: values,
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("/admin/settings/name", { method: "POST" })).status,
    ).toBe(302);
    expect(
      (
        await app.request("/admin/settings/name", {
          method: "POST",
          headers: { authorization: "Bearer tenant-api-key" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await createApp({ authEnabled: false }).request(
          "/admin/settings/name",
          { method: "POST" },
        )
      ).status,
    ).toBe(404);
    expect(mutations).toBe(0);
  });
});
