import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

const denySession = () => Promise.resolve(null);
const allowSession = () =>
  Promise.resolve({
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-1" },
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
