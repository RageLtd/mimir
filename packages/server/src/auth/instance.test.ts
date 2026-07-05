/**
 * MIM-70 slice 1: the better-auth instance constructs against bun:sqlite
 * and its programmatic migrations materialise the core + plugin schema.
 * Runs entirely in-memory — no config env, no filesystem.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { buildAuthOptions } from "./instance";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";

async function migratedDb() {
  const db = new Database(":memory:");
  const options = buildAuthOptions(db, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return { db, options };
}

function tableNames(db: Database) {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name.toLowerCase());
}

describe("better-auth instance (MIM-70 slice 1)", () => {
  test("migrations create the core auth tables", async () => {
    const { db } = await migratedDb();
    const tables = tableNames(db);
    for (const expected of ["user", "session", "account", "verification"]) {
      expect(tables).toContain(expected);
    }
  });

  test("migrations create the organization plugin tables", async () => {
    const { db } = await migratedDb();
    const tables = tableNames(db);
    for (const expected of ["organization", "member", "invitation"]) {
      expect(tables).toContain(expected);
    }
  });

  test("migrations create the api-key and passkey plugin tables", async () => {
    const { db } = await migratedDb();
    const tables = tableNames(db);
    expect(tables.some((t) => t.includes("apikey"))).toBe(true);
    expect(tables.some((t) => t.includes("passkey"))).toBe(true);
  });

  test("betterAuth constructs and exposes a handler against the migrated store", async () => {
    const { options } = await migratedDb();
    const auth = betterAuth(options);
    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.api.getSession).toBe("function");
  });

  test("migrations are idempotent — second run is a no-op, not an error", async () => {
    const { options } = await migratedDb();
    const { toBeCreated, toBeAdded, runMigrations } =
      await getMigrations(options);
    expect(toBeCreated.length).toBe(0);
    expect(toBeAdded.length).toBe(0);
    await runMigrations();
  });
});
