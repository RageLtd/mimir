import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

const denySession = () => Promise.resolve(null);
const allowSession = () =>
  Promise.resolve({
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-1" },
  });
const browserSession = { cookie: "better-auth.session_token=session-1" };
const memberWithRole = (role: string | string[]) => () =>
  Promise.resolve({
    userId: "user-1",
    organizationId: "org-1",
    role,
  });

describe("web route boundary", () => {
  test("auth-off root enters the local dashboard without touching auth stores", async () => {
    const app = createApp({ authEnabled: false });
    const root = await app.request("/");
    const dashboard = await app.request("/app");
    const html = await dashboard.text();

    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/app");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-type")).toContain("text/html");
    expect(html).toStartWith("<!DOCTYPE html>");
    expect(html).toContain("<title>Dashboard — Mimir</title>");
    expect(html).not.toContain("<script");
  });

  test("only the exact public pages and asset namespace bypass identity", async () => {
    const app = createApp({ authEnabled: true, sessionLookup: denySession });

    expect((await app.request("/sign-in")).status).toBe(200);
    expect((await app.request("/sign-up")).status).toBe(200);
    expect((await app.request("/assets/missing.css")).status).toBe(404);
    expect((await app.request("/sign-in/")).status).toBe(401);
    expect((await app.request("/assets")).status).toBe(401);
    expect((await app.request("/assets-private/app.js")).status).toBe(401);
  });

  test("root redirects according to Better Auth session state", async () => {
    const signedOut = await createApp({
      authEnabled: true,
      sessionLookup: denySession,
    }).request("/");
    const signedIn = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
    }).request("/");

    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe("/sign-in");
    expect(signedOut.headers.get("cache-control")).toBe("private, no-store");
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/app");
  });

  test("protected HTML redirects signed-out users and receives resolved identity", async () => {
    const signedOut = await createApp({
      authEnabled: true,
      sessionLookup: denySession,
    }).request("/app/settings?tab=profile");
    const signedIn = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
    }).request("/app");
    const html = await signedIn.text();

    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fapp%2Fsettings%3Ftab%3Dprofile",
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain('data-user-id="user-1"');
    expect(html).toContain('data-organization-id="org-1"');
  });

  test("API failures stay detail-free JSON while browser org failures do not redirect", async () => {
    const noOrganization = createApp({
      authEnabled: true,
      sessionLookup: () =>
        Promise.resolve({ user: { id: "user-1" }, session: {} }),
      orgLister: () => Promise.resolve([{ id: "a" }, { id: "b" }]),
    });
    const deniedApi = await createApp({
      authEnabled: true,
      sessionLookup: denySession,
    }).request("/v1/system-prompt");
    const forbiddenApi = await noOrganization.request("/v1/system-prompt");
    const forbiddenPage = await noOrganization.request("/app");

    expect(deniedApi.status).toBe(401);
    expect(await deniedApi.json()).toEqual({
      error: { message: "Unauthorized" },
    });
    expect(forbiddenApi.status).toBe(403);
    expect(await forbiddenApi.json()).toEqual({
      error: { message: "Forbidden" },
    });
    expect(forbiddenPage.status).toBe(403);
    expect(await forbiddenPage.text()).toBe("Forbidden");
    expect(forbiddenPage.headers.get("location")).toBeNull();
  });
});

describe("organization admin boundary", () => {
  test("owner and admin browser sessions receive the scoped zero-runtime shell", async () => {
    for (const role of ["owner", "admin"]) {
      const response = await createApp({
        authEnabled: true,
        sessionLookup: allowSession,
        activeMemberLookup: memberWithRole(role),
      }).request("/admin", { headers: browserSession });
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(html).toContain("Organization administration — Mimir");
      expect(html).toContain('data-user-id="user-1"');
      expect(html).toContain('data-organization-id="org-1"');
      expect(html).toContain(`data-organization-role="${role}"`);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("Server settings");
    }
  });

  test("ordinary members and mismatched membership records fail closed", async () => {
    const member = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
      activeMemberLookup: memberWithRole("member"),
    }).request("/admin", { headers: browserSession });
    const wrongOrganization = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
      activeMemberLookup: () =>
        Promise.resolve({
          userId: "user-1",
          organizationId: "other-org",
          role: "owner",
        }),
    }).request("/admin", { headers: browserSession });

    expect(member.status).toBe(403);
    expect(await member.text()).toBe("Forbidden");
    expect(wrongOrganization.status).toBe(403);
    expect(await wrongOrganization.text()).toBe("Forbidden");
  });

  test("signed-out browsers redirect while API keys and auth-off deployments cannot enter", async () => {
    let memberLookups = 0;
    const activeMemberLookup = () => {
      memberLookups += 1;
      return memberWithRole("owner")();
    };
    const signedOut = await createApp({
      authEnabled: true,
      sessionLookup: denySession,
      activeMemberLookup,
    }).request("/admin?from=direct");
    const apiKey = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
      activeMemberLookup,
    }).request("/admin", {
      headers: { authorization: "Bearer tenant-api-key" },
    });
    const authOff = await createApp({ authEnabled: false }).request("/admin");

    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%3Ffrom%3Ddirect",
    );
    expect(apiKey.status).toBe(403);
    expect(await apiKey.text()).toBe("Forbidden");
    expect(authOff.status).toBe(404);
    expect(memberLookups).toBe(0);
  });

  test("active organization and role are resolved again for every request", async () => {
    const sessionLookup = (headers: Headers) => {
      const orgId = headers.get("cookie")?.includes("org-2")
        ? "org-2"
        : "org-1";
      return Promise.resolve({
        user: { id: "user-1" },
        session: { activeOrganizationId: orgId },
      });
    };
    const activeMemberLookup = (headers: Headers) => {
      const second = headers.get("cookie")?.includes("org-2");
      return Promise.resolve({
        userId: "user-1",
        organizationId: second ? "org-2" : "org-1",
        role: second ? "member" : "owner",
      });
    };
    const app = createApp({
      authEnabled: true,
      sessionLookup,
      activeMemberLookup,
    });

    expect(
      (
        await app.request("/admin", {
          headers: { cookie: "active=org-1" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/admin", {
          headers: { cookie: "active=org-2" },
        })
      ).status,
    ).toBe(403);
  });

  test("route near-misses stay conservative and representative APIs are unchanged", async () => {
    const app = createApp({
      authEnabled: true,
      sessionLookup: denySession,
      activeMemberLookup: memberWithRole("owner"),
    });

    expect((await app.request("/admin/")).status).toBe(302);
    expect((await app.request("/admin/settings")).status).toBe(302);
    expect((await app.request("/ADMIN")).status).toBe(401);
    expect((await app.request("/administer")).status).toBe(401);
    expect((await app.request("/v1/system-prompt")).status).toBe(401);
  });

  test("organization navigation appears only after eligible role enrichment", async () => {
    const owner = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
      activeMemberLookup: memberWithRole("owner"),
    }).request("/app", { headers: browserSession });
    const member = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
      activeMemberLookup: memberWithRole("member"),
    }).request("/app", { headers: browserSession });

    expect(await owner.text()).toContain('href="/admin"');
    expect(await member.text()).not.toContain('href="/admin"');
  });
});

describe("operator boundary", () => {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  test("operator MCP is disabled when its dedicated token is unset", async () => {
    const response = await createApp({
      authEnabled: false,
      operatorToken: "",
    }).request("/mcp", { method: "POST", body: initialize });

    expect(response.status).toBe(404);
  });

  test("tenant identity cannot authorize the operator MCP", async () => {
    const response = await createApp({
      authEnabled: true,
      sessionLookup: allowSession,
      operatorToken: "operator-secret",
    }).request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer tenant-api-key" },
      body: initialize,
    });

    expect(response.status).toBe(401);
  });

  test("the dedicated operator token authorizes MCP without tenant identity", async () => {
    const response = await createApp({
      authEnabled: true,
      sessionLookup: denySession,
      operatorToken: "operator-secret",
    }).request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer operator-secret" },
      body: initialize,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "mimir" } },
    });
  });
});
