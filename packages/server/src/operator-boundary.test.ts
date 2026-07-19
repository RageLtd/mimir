import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import * as paths from "./operator/paths";
import { operatorTokenDigest } from "./operator/state";
import type { OperatorDashboardOptions } from "./web/operator";

const ORIGIN = "https://mimir.example.test";
const COOKIE = { cookie: "better-auth.session_token=valid" };
const OPERATOR_USER_ID = "operator-1";
const PRIMARY_ORG_ID = "org-1";
const UPDATED_AT = "2026-07-18T00:00:00.000Z";
const PRIVATE_NO_STORE = "private, no-store";
const MCP_PATH = "/mcp";
const SYSTEM_PROMPT_PATH = "/v1/system-prompt";
const FIRST_PROMPT = "First runtime prompt";
const SECOND_PROMPT = "Second runtime prompt";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

function dashboard(overrides: Partial<OperatorDashboardOptions> = {}) {
  return {
    origin: ORIGIN,
    readSettings: () => ({
      instanceName: "Mimir",
      supportUrl: "",
      systemPrompt: "Private by design.",
      operatorMcpCredentialConfigured: true,
      updatedAt: UPDATED_AT,
    }),
    listGrants: () => [
      {
        userId: OPERATOR_USER_ID,
        name: "Operator",
        email: "operator@example.test",
        grantedByUserId: OPERATOR_USER_ID,
        createdAt: UPDATED_AT,
      },
    ],
    listAudit: () => [],
    readHealth: () => ({
      version: "0.3.0",
      tenantStore: "ok",
      userCount: 2,
      organizationCount: 1,
      operatorCount: 1,
    }),
    updateSetting: () => "updated",
    replaceCredential: () => "updated",
    grant: () => "created",
    revoke: () => "revoked",
    provision: () => "created",
    ...overrides,
  } satisfies OperatorDashboardOptions;
}

function session(orgId = PRIMARY_ORG_ID) {
  return Promise.resolve({
    user: { id: OPERATOR_USER_ID },
    session: {
      activeOrganizationId: orgId,
      createdAt: new Date(),
    },
  });
}

function app(options: {
  granted?: () => boolean;
  role?: string;
  operatorDashboard?: OperatorDashboardOptions;
}) {
  return createApp({
    authEnabled: true,
    sessionLookup: () => session(),
    activeMemberLookup: () =>
      Promise.resolve({
        userId: OPERATOR_USER_ID,
        organizationId: PRIMARY_ORG_ID,
        role: options.role ?? "member",
      }),
    operatorGrantLookup: () => options.granted?.() ?? true,
    operatorDashboard: options.operatorDashboard ?? dashboard(),
  });
}

describe("MIM-106 operator route composition", () => {
  test("does not mount the browser dashboard when auth is disabled", async () => {
    const response = await createApp({ authEnabled: false }).request(
      paths.OPERATOR_ROOT_PATH,
    );
    expect(response.status).toBe(404);
  });

  test("uses a stored one-way replacement for MCP and retires the environment fallback", async () => {
    const replacement = "replacement-operator-token-0123456789";
    const instance = createApp({
      authEnabled: true,
      operatorToken: "old-environment-operator-token",
      operatorCredentialDigestLookup: () => operatorTokenDigest(replacement),
    });
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(
      (
        await instance.request(MCP_PATH, {
          method: "POST",
          headers: { authorization: `Bearer ${replacement}` },
          body: initialize,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await instance.request(MCP_PATH, {
          method: "POST",
          headers: {
            authorization: "Bearer old-environment-operator-token",
          },
          body: initialize,
        })
      ).status,
    ).toBe(401);
  });

  test("serves stored system-prompt changes without rebuilding the app", async () => {
    let prompt = FIRST_PROMPT;
    const instance = createApp({
      authEnabled: true,
      sessionLookup: () => session(),
      membershipLookup: ({ userId, orgId }) =>
        Promise.resolve({ userId, organizationId: orgId }),
      systemPromptReader: () => prompt,
    });
    const first = await instance.request(SYSTEM_PROMPT_PATH, {
      headers: COOKIE,
    });
    expect(await first.json()).toMatchObject({ content: FIRST_PROMPT });
    prompt = SECOND_PROMPT;
    const second = await instance.request(SYSTEM_PROMPT_PATH, {
      headers: COOKIE,
    });
    expect(await second.json()).toMatchObject({
      content: SECOND_PROMPT,
    });
  });

  test("redirects signed-out navigation and denies machine credentials", async () => {
    const instance = app({});
    const signedOut = await instance.request(paths.OPERATOR_ROOT_PATH);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toContain("/sign-in");
    expect(signedOut.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);

    for (const headers of [
      new Headers({ authorization: "Bearer operator-machine-token" }),
      new Headers({ "x-api-key": "tenant-api-key" }),
    ]) {
      expect(
        (await instance.request(paths.OPERATOR_ROOT_PATH, { headers })).status,
      ).toBe(403);
    }
  });

  test("serves a private zero-JavaScript shell only to a live grant", async () => {
    const response = await app({}).request(paths.OPERATOR_ROOT_PATH, {
      headers: COOKIE,
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
    expect(html).toContain("Operate this Mimir instance");
    expect(html).toContain(
      '<details open=""><summary>Server operation</summary>',
    );
    expect(html).toContain('href="/app">Account</a>');
    expect(html).not.toContain("<summary>Organization</summary>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("operator-machine-token");
  });

  test("keeps organization administration and instance operation independent", async () => {
    const ownerOperator = await app({ role: "owner" }).request(
      paths.OPERATOR_SETTINGS_PATH,
      { headers: COOKIE },
    );
    const ownerOperatorHtml = await ownerOperator.text();

    expect(ownerOperator.status).toBe(200);
    expect(ownerOperatorHtml).toContain(
      '<details open=""><summary>Organization</summary>',
    );
    expect(ownerOperatorHtml).toContain(
      '<details open=""><summary>Server operation</summary>',
    );
    expect(
      (
        await app({ granted: () => false, role: "owner" }).request(
          paths.OPERATOR_ROOT_PATH,
          { headers: COOKIE },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app({ granted: () => true, role: "member" }).request("/admin", {
          headers: COOKIE,
        })
      ).status,
    ).toBe(403);
  });

  test("revalidates revocation and ignores active-organization switching", async () => {
    let granted = true;
    let orgId = PRIMARY_ORG_ID;
    const instance = createApp({
      authEnabled: true,
      sessionLookup: () => session(orgId),
      activeMemberLookup: () => Promise.resolve(null),
      operatorGrantLookup: () => granted,
      operatorDashboard: dashboard(),
    });
    expect(
      (
        await instance.request(paths.OPERATOR_SETTINGS_PATH, {
          headers: COOKIE,
        })
      ).status,
    ).toBe(200);
    orgId = "org-2";
    expect(
      (
        await instance.request(paths.OPERATOR_SETTINGS_PATH, {
          headers: COOKIE,
        })
      ).status,
    ).toBe(200);
    granted = false;
    expect(
      (
        await instance.request(paths.OPERATOR_SETTINGS_PATH, {
          headers: COOKIE,
        })
      ).status,
    ).toBe(403);
  });

  test("does not widen the prefix to operator-looking routes", async () => {
    const response = await app({ role: "owner" }).request("/operatorium", {
      headers: COOKIE,
    });
    expect(response.status).toBe(404);
  });

  test("requires trusted origin and recent authentication for mutations", async () => {
    let updates = 0;
    const instance = app({
      operatorDashboard: dashboard({
        updateSetting: () => {
          updates += 1;
          return "updated";
        },
      }),
    });
    const body = new URLSearchParams({ value: "Mimir Test" });
    const trusted = await instance.request(paths.OPERATOR_SETTINGS_NAME_PATH, {
      method: "POST",
      headers: {
        ...COOKIE,
        origin: ORIGIN,
        "content-type": FORM_CONTENT_TYPE,
      },
      body,
    });
    expect(trusted.status).toBe(303);
    expect(updates).toBe(1);

    const untrusted = await instance.request(
      paths.OPERATOR_SETTINGS_NAME_PATH,
      {
        method: "POST",
        headers: {
          ...COOKIE,
          origin: "https://attacker.example",
          "content-type": FORM_CONTENT_TYPE,
        },
        body: new URLSearchParams({ value: "Compromised" }),
      },
    );
    expect(untrusted.status).toBe(200);
    expect(updates).toBe(1);
  });
});
