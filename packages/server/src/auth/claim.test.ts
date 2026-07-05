/**
 * MIM-70 slice 2: signup policy (claim window + invite-only afterward),
 * token comparison, and the sqlite row-count helpers against a real
 * in-memory migrated store.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getMigrations } from "better-auth/db/migration";
import { buildAuthOptions } from "./instance";
import {
  countUsers,
  pendingInviteExists,
  setCookiesToCookieHeader,
  signupDecision,
  tokenMatches,
} from "./claim";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

async function migratedDb() {
  const db = new Database(":memory:");
  const { runMigrations } = await getMigrations(
    buildAuthOptions(db, TEST_SECRET),
  );
  await runMigrations();
  return db;
}

describe("tokenMatches", () => {
  test("accepts an exact match", () => {
    expect(tokenMatches("claim-token", "claim-token")).toBe(true);
  });
  test("rejects mismatches, empties, and near-misses", () => {
    expect(tokenMatches("wrong", "claim-token")).toBe(false);
    expect(tokenMatches("", "claim-token")).toBe(false);
    expect(tokenMatches("claim-token", "")).toBe(false);
    expect(tokenMatches("claim-token ", "claim-token")).toBe(false);
  });
});

describe("signupDecision", () => {
  test("claim window: valid token claims the instance", () => {
    const d = signupDecision({
      userCount: 0,
      hasPendingInvite: false,
      tokenConfigured: true,
      tokenValid: true,
    });
    expect(d).toEqual({ allow: true, claim: true });
  });

  test("claim window: missing/invalid token is rejected", () => {
    const d = signupDecision({
      userCount: 0,
      hasPendingInvite: false,
      tokenConfigured: true,
      tokenValid: false,
    });
    expect(d.allow).toBe(false);
  });

  test("claim window: unconfigured setup token makes claim impossible", () => {
    const d = signupDecision({
      userCount: 0,
      hasPendingInvite: false,
      tokenConfigured: false,
      tokenValid: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("AUTH_SETUP_TOKEN");
    }
  });

  test("claimed instance: signup closed without an invitation — even with a valid token", () => {
    const d = signupDecision({
      userCount: 1,
      hasPendingInvite: false,
      tokenConfigured: true,
      tokenValid: true,
    });
    expect(d.allow).toBe(false);
  });

  test("claimed instance: pending invitation opens signup for that email", () => {
    const d = signupDecision({
      userCount: 3,
      hasPendingInvite: true,
      tokenConfigured: false,
      tokenValid: false,
    });
    expect(d).toEqual({ allow: true, claim: false });
  });
});

describe("sqlite helpers", () => {
  test("countUsers reflects inserted rows", async () => {
    const db = await migratedDb();
    expect(countUsers(db)).toBe(0);
    db.run(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('u1', 'Test', 't@t.local', 0, datetime('now'), datetime('now'))`,
    );
    expect(countUsers(db)).toBe(1);
  });

  test("pendingInviteExists matches only pending rows for the email", async () => {
    const db = await migratedDb();
    expect(pendingInviteExists(db, "in@t.local")).toBe(false);
    expect(pendingInviteExists(db, "")).toBe(false);
    db.run(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('u1', 'Owner', 'o@t.local', 0, datetime('now'), datetime('now'))`,
    );
    db.run(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES ('o1', 'Owner', 'owner', datetime('now'))`,
    );
    db.run(
      `INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, inviterId, createdAt)
       VALUES ('i1', 'o1', 'in@t.local', 'member', 'pending', datetime('now', '+7 days'), 'u1', datetime('now'))`,
    );
    expect(pendingInviteExists(db, "in@t.local")).toBe(true);
    expect(pendingInviteExists(db, "other@t.local")).toBe(false);
    db.run("UPDATE invitation SET status = 'accepted' WHERE id = 'i1'");
    expect(pendingInviteExists(db, "in@t.local")).toBe(false);
  });
});

describe("setCookiesToCookieHeader", () => {
  test("collapses Set-Cookie values into a Cookie header", () => {
    expect(
      setCookiesToCookieHeader([
        "better-auth.session_token=abc123; Path=/; HttpOnly; SameSite=Lax",
        "other=x; Path=/",
      ]),
    ).toBe("better-auth.session_token=abc123; other=x");
  });
  test("empty input yields empty string", () => {
    expect(setCookiesToCookieHeader([])).toBe("");
  });
});
