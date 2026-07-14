import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createApp } from "../app";
import {
  bootstrapOwnerOrg,
  createClaimGuard,
  setCookiesToCookieHeader,
} from "../auth/claim";
import { buildAuthOptions } from "../auth/instance";
import { config } from "../config";
import { createKeysRoutes } from "../routes/keys";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";
const SETUP_TOKEN = "credential-test-claim";
const ORIGIN = new URL(config.auth.baseUrl).origin;
const PASSWORD = "owner-password-123";

async function credentialApp() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  const app = createApp({
    authEnabled: true,
    authHandler: (request) => auth.handler(request),
    claimGuard: createClaimGuard({
      db,
      setupToken: SETUP_TOKEN,
      bootstrap: (response) => bootstrapOwnerOrg(response, auth),
    }),
    sessionLookup: (headers) => auth.api.getSession({ headers }),
    orgLister: (headers) => auth.api.listOrganizations({ headers }),
    activeMemberLookup: (headers) => auth.api.getActiveMember({ headers }),
    keyRoutes: createKeysRoutes(() => db),
  });
  const signup = await postForm(
    app,
    "/sign-up",
    {
      name: "Owner",
      email: "owner@example.test",
      password: PASSWORD,
      setupToken: SETUP_TOKEN,
      returnTo: "/app",
    },
    "",
  );
  const cookie = setCookiesToCookieHeader(signup.headers.getSetCookie());
  return { app, auth, db, cookie };
}

function postForm(
  app: ReturnType<typeof createApp>,
  path: string,
  values: Record<string, string>,
  cookie: string,
  origin = ORIGIN,
) {
  return app.request(path, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
}

describe("credential dashboard", () => {
  test("protects the route and SSRs metadata without opaque key or session material", async () => {
    const { app, db, cookie } = await credentialApp();
    const user = db.query('SELECT id FROM "user"').get();
    const userId =
      user && typeof user === "object" && "id" in user ? user.id : null;
    if (typeof userId !== "string") {
      throw new Error("missing test user");
    }
    db.query(
      'UPDATE "user" SET publicKey = ?, encryptedKeyset = ? WHERE id = ?',
    ).run("public-browser-key", "encrypted-keyset-never-render", userId);
    db.query("UPDATE member SET wrappedOrgKey = ? WHERE userId = ?").run(
      "wrapped-org-key-never-render",
      userId,
    );

    const signedOut = await app.request("/app/credentials");
    const response = await app.request("/app/credentials", {
      headers: { cookie },
    });
    const html = await response.text();
    const token = db.query("SELECT token FROM session").get();

    expect(signedOut.status).toBe(302);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain("<title>Credentials — Mimir</title>");
    expect(html).toContain('src="/assets/credentials.js"');
    expect(html).toContain("Public key</dt><dd>Registered");
    expect(html).toContain("Encrypted keyset</dt><dd>Stored");
    expect(html).toContain("Organization wrap</dt><dd>Available");
    expect(html).not.toContain("encrypted-keyset-never-render");
    expect(html).not.toContain("wrapped-org-key-never-render");
    if (token && typeof token === "object" && "token" in token) {
      expect(html).not.toContain(String(token.token));
    }
  });

  test("creates an API key after password verification and shows its secret once", async () => {
    const { app, db, cookie } = await credentialApp();
    const response = await postForm(
      app,
      "/app/credentials/api-keys",
      { name: "Zed", currentPassword: PASSWORD },
      cookie,
    );
    const html = await response.text();
    const secret = /<output class="secret">([^<]+)<\/output>/.exec(html)?.[1];

    expect(response.status).toBe(200);
    expect(secret?.length).toBeGreaterThan(20);
    expect(html).toContain("The full secret will not be shown again.");
    expect(db.query("SELECT count(*) AS count FROM apikey").get()).toEqual({
      count: 1,
    });

    const later = await app.request("/app/credentials", {
      headers: { cookie },
    });
    expect(await later.text()).not.toContain(secret ?? "missing-secret");
  });

  test("rejects untrusted form origins before mutating credentials", async () => {
    const { app, db, cookie } = await credentialApp();
    const response = await postForm(
      app,
      "/app/credentials/api-keys",
      { name: "Attacker", currentPassword: PASSWORD },
      cookie,
      "https://evil.example",
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).not.toContain(PASSWORD);
    expect(db.query("SELECT count(*) AS count FROM apikey").get()).toEqual({
      count: 0,
    });
  });

  test("changes the password and can revoke every other browser session", async () => {
    const { app, cookie } = await credentialApp();
    const secondSignin = await postForm(
      app,
      "/sign-in",
      {
        email: "owner@example.test",
        password: PASSWORD,
        returnTo: "/app",
      },
      "",
    );
    const secondCookie = setCookiesToCookieHeader(
      secondSignin.headers.getSetCookie(),
    );
    const revoked = await postForm(
      app,
      "/app/credentials/sessions/revoke-others",
      {},
      cookie,
    );

    expect(revoked.status).toBe(303);
    expect(
      (await app.request("/app", { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (await app.request("/app", { headers: { cookie: secondCookie } })).status,
    ).toBe(302);

    const changed = await postForm(
      app,
      "/app/credentials/password",
      {
        currentPassword: PASSWORD,
        newPassword: "new-owner-password-456",
        revokeOtherSessions: "yes",
      },
      cookie,
    );
    expect(changed.status).toBe(303);
    const oldSignin = await postForm(
      app,
      "/sign-in",
      {
        email: "owner@example.test",
        password: PASSWORD,
        returnTo: "/app",
      },
      "",
    );
    const newSignin = await postForm(
      app,
      "/sign-in",
      {
        email: "owner@example.test",
        password: "new-owner-password-456",
        returnTo: "/app",
      },
      "",
    );
    expect(oldSignin.status).toBe(401);
    expect(newSignin.status).toBe(303);
  });

  test("lists, renames, and removes only the signed-in user's passkeys", async () => {
    const { app, db, cookie } = await credentialApp();
    const user = db.query('SELECT id FROM "user"').get();
    const userId =
      user && typeof user === "object" && "id" in user ? user.id : null;
    if (typeof userId !== "string") {
      throw new Error("missing test user");
    }
    db.query(
      `INSERT INTO passkey
       (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, transports, createdAt)
       VALUES ('passkey-1', 'Laptop', 'public', ?, 'credential-1', 0, 'singleDevice', 0, 'internal', ?)`,
    ).run(userId, new Date().toISOString());

    const listed = await app.request("/app/credentials", {
      headers: { cookie },
    });
    expect(await listed.text()).toContain("Laptop");

    const renamed = await postForm(
      app,
      "/app/credentials/passkeys/rename",
      { id: "passkey-1", name: "Desk" },
      cookie,
    );
    expect(renamed.status).toBe(303);
    expect(
      db.query("SELECT name FROM passkey WHERE id = 'passkey-1'").get(),
    ).toEqual({ name: "Desk" });

    const removed = await postForm(
      app,
      "/app/credentials/passkeys/revoke",
      { id: "passkey-1" },
      cookie,
    );
    expect(removed.status).toBe(303);
    expect(
      db.query("SELECT count(*) AS count FROM passkey").get(),
    ).toEqual({ count: 0 });
  });
});
