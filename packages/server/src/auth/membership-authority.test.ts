import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Hono } from "hono";
import { migrateOrganizationAudit } from "../audit/store";
import { createTenantDb } from "../db/tenant";
import {
  createIdentityGate,
  type IdentityEnv,
  type MembershipLookup,
  toAuthHeaders,
} from "../middleware/identity";
import { createSyncRoutes } from "../routes/sync";
import { buildAuthOptions } from "./instance";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

function cookieFrom(response: { headers: Headers }) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

const envelope = (id: string) => ({
  id,
  kind: 1,
  v: 2,
  suite: 1,
  keyGen: 1,
  version: 1,
  tombstone: false,
  nonce: "AAECAwQFBgcICQoL",
  payload: "AAECAwQFBgcICQoLDA0ODw",
});

describe("authoritative organization membership", () => {
  test("removal denies every stale browser session and API key on sync immediately", async () => {
    const authDb = new Database(":memory:");
    const options = buildAuthOptions(authDb, TEST_SECRET);
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    migrateOrganizationAudit(authDb);
    const auth = betterAuth(options);

    const owner = await auth.api.signUpEmail({
      body: {
        email: "owner@example.test",
        password: "owner-password-123",
        name: "Owner",
      },
      returnHeaders: true,
    });
    const ownerCookie = cookieFrom(owner);
    await auth.api.createOrganization({
      body: { name: "Authority Org", slug: "authority-org" },
      headers: new Headers({ cookie: ownerCookie }),
    });
    const organization = authDb
      .query<{ id: string }, []>(
        "SELECT id FROM organization WHERE slug = 'authority-org'",
      )
      .get();
    if (!organization) throw new Error("missing test organization");

    const firstSession = await auth.api.signUpEmail({
      body: {
        email: "member@example.test",
        password: "member-password-123",
        name: "Member",
      },
      returnHeaders: true,
    });
    const memberUserId = firstSession.response.user.id;
    const memberId = crypto.randomUUID();
    authDb
      .query(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)",
      )
      .run(
        memberId,
        organization.id,
        memberUserId,
        new Date().toISOString(),
      );
    const secondSession = await auth.api.signInEmail({
      body: {
        email: "member@example.test",
        password: "member-password-123",
      },
      returnHeaders: true,
    });
    authDb
      .query("UPDATE session SET activeOrganizationId = ? WHERE userId = ?")
      .run(organization.id, memberUserId);
    const apiKey = await auth.api.createApiKey({
      body: { name: "stale-member-key", userId: memberUserId },
    });

    const membershipLookup: MembershipLookup = ({ userId, orgId }) =>
      Promise.resolve(
        authDb
          .query(
            `SELECT m.userId, m.organizationId
               FROM member m JOIN organization o ON o.id = m.organizationId
              WHERE m.userId = ? AND m.organizationId = ?`,
          )
          .get(userId, orgId),
      );
    const tenantDb = createTenantDb(":memory:");
    const app = new Hono<IdentityEnv>();
    app.use(
      "*",
      createIdentityGate(
        (headers) => auth.api.getSession({ headers }),
        (headers) => auth.api.listOrganizations({ headers }),
        () => false,
        membershipLookup,
      ),
    );
    app.route("/v1/sync", createSyncRoutes(() => tenantDb, () => 1));

    const credentials = [
      new Headers({ cookie: cookieFrom(firstSession) }),
      new Headers({ cookie: cookieFrom(secondSession) }),
      new Headers({ authorization: `Bearer ${apiKey.key}` }),
    ];
    for (const [index, credential] of credentials.entries()) {
      const headers = new Headers(credential);
      headers.set("content-type", "application/json");
      const response = await app.request("/v1/sync/push", {
        method: "POST",
        headers,
        body: JSON.stringify({ envelopes: [envelope(`memory:${index}`)] }),
      });
      expect(response.status).toBe(200);
    }

    authDb
      .query("DELETE FROM member WHERE id = ? AND organizationId = ?")
      .run(memberId, organization.id);

    for (const credential of credentials) {
      const response = await app.request("/v1/sync/pull", {
        headers: credential,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { message: "Forbidden" },
      });
    }

    expect(
      await auth.api.getSession({
        headers: toAuthHeaders({ cookie: cookieFrom(firstSession) }),
      }),
    ).not.toBeNull();
  });
});
