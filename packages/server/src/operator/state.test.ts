import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { buildAuthOptions } from "../auth/instance";
import {
  grantInitialOperator,
  grantOperator,
  hasOperatorGrant,
  listOperatorAudit,
  migrateOperatorState,
  operatorTokenDigest,
  provisionOrganization,
  readInstanceSettings,
  readOperatorCredentialDigest,
  replaceOperatorCredential,
  revokeOperator,
  updateInstanceSetting,
} from "./state";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";
// Must track the real clock, never a pinned instant. provisionOrganization
// derives the invitation's expiresAt from this injected clock, but
// auth.api.acceptInvitation validates that expiry against the real wall
// clock — a fixed date silently rots into `Invitation not found` once
// DEFAULT_INVITATION_LIFETIME_DAYS elapses, failing CI on a delay rather
// than on a change.
const NOW = () => new Date();

async function migrated() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  migrateOperatorState(db, { systemPromptSeed: "Seed prompt", now: NOW });
  return { auth: betterAuth(options), db };
}

async function signup(
  db: Database,
  auth: Awaited<ReturnType<typeof migrated>>["auth"],
  email: string,
) {
  const response = await auth.api.signUpEmail({
    body: {
      email,
      password: "operator-test-password",
      name: email.split("@")[0] ?? "User",
    },
    returnHeaders: true,
  });
  const user = db
    .query<{ id: string }, [string]>('SELECT id FROM "user" WHERE email = ?')
    .get(email);
  if (!user) throw new Error("test user was not created");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { cookie, userId: user.id };
}

function mutation(actorUserId: string) {
  return {
    actorUserId,
    requestId: crypto.randomUUID(),
    recentAuthentication: true,
  };
}

describe("instance operator state", () => {
  test("imports configured user ids once so revocation survives restart", async () => {
    const { auth, db } = await migrated();
    const { userId } = await signup(db, auth, "bootstrap@example.test");

    migrateOperatorState(db, { bootstrapUserIds: [userId], now: NOW });
    expect(hasOperatorGrant(db, userId)).toBe(true);

    db.query("DELETE FROM instance_operator_grant WHERE user_id = ?").run(
      userId,
    );
    migrateOperatorState(db, { bootstrapUserIds: [userId], now: NOW });
    expect(hasOperatorGrant(db, userId)).toBe(false);
  });

  test("rolls back an initial grant when its audit record cannot be written", async () => {
    const { auth, db } = await migrated();
    const { userId } = await signup(db, auth, "audit-failure@example.test");
    db.run("DROP TABLE instance_operator_audit_event");

    expect(() => grantInitialOperator(db, userId, NOW)).toThrow();
    expect(hasOperatorGrant(db, userId)).toBe(false);
  });

  test("applies bounded runtime settings without auditing their values", async () => {
    const { auth, db } = await migrated();
    const { userId } = await signup(db, auth, "settings@example.test");
    grantInitialOperator(db, userId, NOW);

    expect(readInstanceSettings(db).systemPrompt).toBe("Seed prompt");
    expect(
      updateInstanceSetting(
        db,
        {
          ...mutation(userId),
          field: "support_url",
          value: "https://support.example.test/private-path",
        },
        NOW,
      ),
    ).toBe("updated");
    expect(readInstanceSettings(db).supportUrl).toBe(
      "https://support.example.test/private-path",
    );
    expect(
      updateInstanceSetting(
        db,
        {
          ...mutation(userId),
          field: "support_url",
          value: "file:///etc/passwd",
        },
        NOW,
      ),
    ).toBe("rejected");

    const serializedAudit = JSON.stringify(
      db.query("SELECT * FROM instance_operator_audit_event").all(),
    );
    expect(serializedAudit).not.toContain("support.example.test");
    expect(serializedAudit).not.toContain("/etc/passwd");
  });

  test("stores only a digest when the MCP credential is replaced", async () => {
    const { auth, db } = await migrated();
    const { userId } = await signup(db, auth, "credential@example.test");
    grantInitialOperator(db, userId, NOW);
    const token = "high-entropy-operator-token-0123456789";

    expect(
      replaceOperatorCredential(db, { ...mutation(userId), token }, NOW),
    ).toBe("updated");
    expect(readOperatorCredentialDigest(db)).toBe(operatorTokenDigest(token));
    expect(
      JSON.stringify(db.query("SELECT * FROM instance_setting").all()),
    ).not.toContain(token);
    expect(JSON.stringify(listOperatorAudit(db))).not.toContain(token);
  });

  test("revalidates grants and refuses to remove the final operator", async () => {
    const { auth, db } = await migrated();
    const first = await signup(db, auth, "first@example.test");
    const second = await signup(db, auth, "second@example.test");
    grantInitialOperator(db, first.userId, NOW);

    expect(
      grantOperator(
        db,
        { ...mutation(first.userId), email: "second@example.test" },
        NOW,
      ),
    ).toBe("created");
    expect(hasOperatorGrant(db, second.userId)).toBe(true);
    expect(
      revokeOperator(
        db,
        { ...mutation(first.userId), userId: second.userId },
        NOW,
      ),
    ).toBe("revoked");
    expect(hasOperatorGrant(db, second.userId)).toBe(false);
    expect(
      revokeOperator(
        db,
        { ...mutation(first.userId), userId: first.userId },
        NOW,
      ),
    ).toBe("rejected");
  });

  test("atomically provisions an organization and usable owner invitation without enrolling the operator", async () => {
    const { auth, db } = await migrated();
    const operator = await signup(db, auth, "operator@example.test");
    const owner = await signup(db, auth, "owner@example.test");
    grantInitialOperator(db, operator.userId, NOW);

    const input = {
      ...mutation(operator.userId),
      name: "Tester Organization",
      slug: "tester-organization",
      ownerEmail: "owner@example.test",
    };
    expect(provisionOrganization(db, input, NOW)).toBe("created");
    expect(provisionOrganization(db, input, NOW)).toBe("rejected");

    const organization = db
      .query<{ id: string }, []>(
        "SELECT id FROM organization WHERE slug = 'tester-organization'",
      )
      .get();
    const invitation = db
      .query<{ id: string; role: string }, []>(
        "SELECT id, role FROM invitation WHERE email = 'owner@example.test'",
      )
      .get();
    if (!organization || !invitation) {
      throw new Error("provisioned records are missing");
    }
    expect(invitation.role).toBe("owner");
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM member WHERE organizationId = ?",
        )
        .get(organization.id)?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM invitation WHERE email = 'owner@example.test'",
        )
        .get()?.count,
    ).toBe(1);

    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: new Headers({ cookie: owner.cookie }),
    });
    const membership = db
      .query<{ role: string }, [string, string]>(
        `SELECT role FROM member
          WHERE userId = ? AND organizationId = ?`,
      )
      .get(owner.userId, organization.id);
    expect(membership?.role).toBe("owner");
    expect(
      db
        .query<{ count: number }, [string, string]>(
          `SELECT count(*) AS count FROM member
            WHERE userId = ? AND organizationId = ?`,
        )
        .get(operator.userId, organization.id)?.count,
    ).toBe(0);
  });

  test("rejects mutations without recent authentication and records failure", async () => {
    const { auth, db } = await migrated();
    const { userId } = await signup(db, auth, "stale@example.test");
    grantInitialOperator(db, userId, NOW);

    expect(
      updateInstanceSetting(
        db,
        {
          ...mutation(userId),
          recentAuthentication: false,
          field: "instance_name",
          value: "Changed",
        },
        NOW,
      ),
    ).toBe("rejected");
    expect(readInstanceSettings(db).instanceName).toBe("Mimir");
    expect(listOperatorAudit(db)[0]?.outcome).toBe("failed");
  });
});
