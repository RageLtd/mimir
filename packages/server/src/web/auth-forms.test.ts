import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createApp } from "../app";
import { migrateOrganizationAudit } from "../audit/store";
import {
  bootstrapOwnerOrg,
  countUsers,
  createClaimGuard,
  setCookiesToCookieHeader,
} from "../auth/claim";
import { buildAuthOptions } from "../auth/instance";
import { SETUP_TOKEN_HEADER, SIGNUP_PATH } from "../auth/paths";
import { config } from "../config";
import { hasOperatorGrant, migrateOperatorState } from "../operator/state";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";
const SETUP_TOKEN = "first-claim-token";
const ORIGIN = new URL(config.auth.baseUrl).origin;

async function formApp() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  migrateOrganizationAudit(db);
  migrateOperatorState(db);
  const auth = betterAuth(options);
  const app = createApp({
    authEnabled: true,
    authHandler: (request) => auth.handler(request),
    claimGuard: createClaimGuard({
      db,
      setupToken: SETUP_TOKEN,
      auth,
      bootstrap: (response) => bootstrapOwnerOrg(response, auth),
    }),
    sessionLookup: (headers) => auth.api.getSession({ headers }),
    orgLister: (headers) => auth.api.listOrganizations({ headers }),
    membershipLookup: ({ userId, orgId }) =>
      Promise.resolve(
        db
          .query(
            `SELECT m.userId, m.organizationId
               FROM member m JOIN organization o ON o.id = m.organizationId
              WHERE m.userId = ? AND m.organizationId = ?`,
          )
          .get(userId, orgId),
      ),
    activeMemberLookup: (headers) => auth.api.getActiveMember({ headers }),
    operatorGrantLookup: (userId) => hasOperatorGrant(db, userId),
  });
  return { app, auth, db };
}

function postForm(
  app: ReturnType<typeof createApp>,
  path: string,
  values: Record<string, string>,
  origin: string | null = ORIGIN,
) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (origin) headers.set("origin", origin);
  return app.request(path, {
    method: "POST",
    headers,
    body: new URLSearchParams(values),
  });
}

describe("Better Auth HTML forms", () => {
  test("first claim and later sign-in establish real dashboard sessions", async () => {
    const { app, db } = await formApp();
    const signup = await postForm(app, "/sign-up", {
      name: "Owner",
      email: "owner@example.test",
      password: "owner-password-123",
      setupToken: SETUP_TOKEN,
      returnTo: "/app?welcome=1",
    });
    const signupCookie = setCookiesToCookieHeader(
      signup.headers.getSetCookie(),
    );

    expect(signup.status).toBe(303);
    expect(signup.headers.get("location")).toBe("/app?welcome=1");
    expect(signup.headers.get("cache-control")).toBe("private, no-store");
    expect(signupCookie).not.toBe("");
    expect(countUsers(db)).toBe(1);
    const claimedUser = db
      .query<{ id: string }, []>('SELECT id FROM "user"')
      .get();
    expect(claimedUser && hasOperatorGrant(db, claimedUser.id)).toBe(true);
    expect(db.query("SELECT count(*) AS c FROM organization").get()).toEqual({
      c: 1,
    });
    expect(
      (await app.request("/app", { headers: { cookie: signupCookie } })).status,
    ).toBe(200);
    expect(
      (await app.request("/admin", { headers: { cookie: signupCookie } }))
        .status,
    ).toBe(302);
    db.run("UPDATE member SET role = 'member'");
    expect(
      (await app.request("/admin", { headers: { cookie: signupCookie } }))
        .status,
    ).toBe(403);

    const signin = await postForm(app, "/sign-in", {
      email: "owner@example.test",
      password: "owner-password-123",
      returnTo: "/app",
    });
    const signinCookie = setCookiesToCookieHeader(
      signin.headers.getSetCookie(),
    );

    expect(signin.status).toBe(303);
    expect(signin.headers.get("location")).toBe("/app");
    expect(signinCookie).not.toBe("");
    expect(
      (await app.request("/app", { headers: { cookie: signinCookie } })).status,
    ).toBe(200);
  });

  test("claim policy stays closed except for the configured token or an invitation", async () => {
    const { app, db } = await formApp();
    const deniedClaim = await postForm(app, "/sign-up", {
      name: "Attacker",
      email: "attacker@example.test",
      password: "attacker-password-123",
      setupToken: "wrong-token",
      returnTo: "/app",
    });
    expect(deniedClaim.status).toBe(403);
    expect(countUsers(db)).toBe(0);

    await postForm(app, "/sign-up", {
      name: "Owner",
      email: "owner@example.test",
      password: "owner-password-123",
      setupToken: SETUP_TOKEN,
      returnTo: "/app",
    });
    const closedSignup = await postForm(app, "/sign-up", {
      name: "Uninvited",
      email: "uninvited@example.test",
      password: "uninvited-password-123",
      setupToken: SETUP_TOKEN,
      returnTo: "/app",
    });
    expect(closedSignup.status).toBe(403);
    expect(countUsers(db)).toBe(1);

    const owner = db.query('SELECT id FROM "user"').get() as { id: string };
    const organization = db.query("SELECT id FROM organization").get() as {
      id: string;
    };
    db.run(
      `INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, inviterId, createdAt)
       VALUES ('invite-1', ?, 'invited@example.test', 'member', 'pending', datetime('now', '+7 days'), ?, datetime('now'))`,
      [organization.id, owner.id],
    );
    const invitedSignup = await postForm(app, "/sign-up", {
      name: "Invited",
      email: "invited@example.test",
      password: "invited-password-123",
      setupToken: "",
      returnTo: "/app",
    });
    expect(invitedSignup.status).toBe(303);
    expect(countUsers(db)).toBe(2);
    expect(
      db
        .query(
          `SELECT i.status, m.role
             FROM invitation i JOIN member m ON m.organizationId = i.organizationId
             JOIN "user" u ON u.id = m.userId
            WHERE i.email = 'invited@example.test' AND u.email = i.email`,
        )
        .get(),
    ).toEqual({ status: "accepted", role: "member" });
  });

  test("origin failures and invalid credentials stay generic and do not reflect secrets", async () => {
    const { app, db } = await formApp();
    const missingOrigin = await postForm(
      app,
      "/sign-up",
      {
        name: "Owner",
        email: "owner@example.test",
        password: "never-reflect-this-password",
        setupToken: SETUP_TOKEN,
        returnTo: "/app",
      },
      null,
    );
    const missingOriginHtml = await missingOrigin.text();
    expect(missingOrigin.status).toBe(403);
    expect(countUsers(db)).toBe(0);
    expect(missingOriginHtml).toContain('role="alert"');
    expect(missingOriginHtml).toContain('value="owner@example.test"');
    expect(missingOriginHtml).not.toContain("never-reflect-this-password");
    expect(missingOriginHtml).not.toContain(SETUP_TOKEN);

    const untrustedOrigin = await postForm(
      app,
      "/sign-up",
      {
        name: "Owner",
        email: "owner@example.test",
        password: "owner-password-123",
        setupToken: SETUP_TOKEN,
        returnTo: "/app",
      },
      "https://evil.example",
    );
    expect(untrustedOrigin.status).toBe(403);
    expect(countUsers(db)).toBe(0);

    await postForm(app, "/sign-up", {
      name: "Owner",
      email: "owner@example.test",
      password: "owner-password-123",
      setupToken: SETUP_TOKEN,
      returnTo: "/app",
    });
    const invalidSignin = await postForm(app, "/sign-in", {
      email: "owner@example.test",
      password: "wrong-password-never-reflect",
      returnTo: "/app",
    });
    const invalidSigninHtml = await invalidSignin.text();
    expect(invalidSignin.status).toBe(401);
    expect(invalidSigninHtml).toContain('role="alert"');
    expect(invalidSigninHtml).toContain('value="owner@example.test"');
    expect(invalidSigninHtml).not.toContain("wrong-password-never-reflect");
  });

  test("successful authentication normalizes unsafe return targets", async () => {
    const { app } = await formApp();
    const signup = await postForm(app, "/sign-up", {
      name: "Owner",
      email: "owner@example.test",
      password: "owner-password-123",
      setupToken: SETUP_TOKEN,
      returnTo: "https://evil.example/steal",
    });
    expect(signup.status).toBe(303);
    expect(signup.headers.get("location")).toBe("/app");
  });

  test("malformed form bodies fail before reaching Better Auth", async () => {
    const { app, db } = await formApp();
    const response = await app.request("/sign-up", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        email: "owner@example.test",
        password: "json-password-never-reflect",
        setupToken: SETUP_TOKEN,
      }),
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(countUsers(db)).toBe(0);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("json-password-never-reflect");
    expect(html).not.toContain(SETUP_TOKEN);
  });

  test("the existing Better Auth JSON endpoint remains unchanged", async () => {
    const { app } = await formApp();
    const response = await app.request(SIGNUP_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        [SETUP_TOKEN_HEADER]: SETUP_TOKEN,
      },
      body: JSON.stringify({
        name: "API Owner",
        email: "api-owner@example.test",
        password: "api-owner-password-123",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(body).toMatchObject({ user: { email: "api-owner@example.test" } });
  });
});
