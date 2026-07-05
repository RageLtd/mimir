/**
 * MIM-70 slice 3 / MIM-75 key shelf: the E2E wrapped-key distribution
 * fields exist as columns after migration, and better-auth's own endpoints
 * accept + return them (the server stores ciphertext it cannot open —
 * these tests only prove the shelf holds what's put on it).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { buildAuthOptions } from "./instance";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

async function migratedAuth() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return { db, auth: betterAuth(options) };
}

function columns(db: Database, table: string) {
  const rows = db.query(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

describe("MIM-75 key shelf schema", () => {
  test("user carries publicKey", async () => {
    const { db } = await migratedAuth();
    expect(columns(db, "user")).toContain("publicKey");
  });

  test("member carries wrappedOrgKey", async () => {
    const { db } = await migratedAuth();
    expect(columns(db, "member")).toContain("wrappedOrgKey");
  });

  test("organization carries the recovery keyset fields", async () => {
    const { db } = await migratedAuth();
    const cols = columns(db, "organization");
    expect(cols).toContain("recoveryPublicKey");
    expect(cols).toContain("wrappedRecoveryKey");
  });
});

describe("MIM-75 key shelf round-trip through better-auth endpoints", () => {
  test("sign-up accepts publicKey and stores it verbatim", async () => {
    const { db, auth } = await migratedAuth();
    await auth.api.signUpEmail({
      body: {
        email: "shelf@test.local",
        password: "shelf-password-123",
        name: "Shelf",
        publicKey: "x25519-public-half-base64",
      },
    });
    const row = db
      .query('SELECT publicKey FROM "user" WHERE email = ?')
      .get("shelf@test.local") as { publicKey: string | null };
    expect(row.publicKey).toBe("x25519-public-half-base64");
  });

  test("organization creation accepts the recovery keyset fields", async () => {
    const { db, auth } = await migratedAuth();
    const signup = await auth.api.signUpEmail({
      body: {
        email: "owner@test.local",
        password: "owner-password-123",
        name: "Owner",
      },
      returnHeaders: true,
    });
    const cookie = signup.headers
      .getSetCookie()
      .map((sc) => sc.split(";")[0])
      .join("; ");
    await auth.api.createOrganization({
      body: {
        name: "Shelf Org",
        slug: "shelf-org",
        recoveryPublicKey: "recovery-public-half",
        wrappedRecoveryKey: "org-key-wrapped-to-recovery",
      },
      headers: new Headers({ cookie }),
    });
    const row = db
      .query(
        "SELECT recoveryPublicKey, wrappedRecoveryKey FROM organization WHERE slug = 'shelf-org'",
      )
      .get() as {
      recoveryPublicKey: string | null;
      wrappedRecoveryKey: string | null;
    };
    expect(row.recoveryPublicKey).toBe("recovery-public-half");
    expect(row.wrappedRecoveryKey).toBe("org-key-wrapped-to-recovery");
  });
});
