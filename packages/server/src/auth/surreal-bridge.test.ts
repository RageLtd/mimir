/**
 * MIM-70 slice 4: the Surreal record-access bridge — JWT signing verified
 * by recomputation, claim assembly per SurrealDB's database-level contract
 * (exp/ac/ns/db), and DEFINE ACCESS statement construction.
 */

import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildDefineAccessSql,
  buildSurrealClaims,
  buildTablePermissionsSql,
  mintSurrealToken,
  SURREAL_ACCESS_NAME,
  signJwtHs256,
} from "./surreal-bridge";

const SECRET = "bridge-test-secret-of-decent-length!";

function decodeSegment(seg: string) {
  return JSON.parse(Buffer.from(seg, "base64url").toString());
}

describe("signJwtHs256", () => {
  test("produces header.payload.signature with a recomputable HMAC", () => {
    const token = signJwtHs256({ sub: "u1", exp: 123 }, SECRET);
    const [header = "", payload = "", signature = ""] = token.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decodeSegment(payload)).toEqual({ sub: "u1", exp: 123 });
    const expected = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expected);
  });

  test("tampered payload no longer matches the signature", () => {
    const token = signJwtHs256({ sub: "u1" }, SECRET);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "u2" })).toString(
      "base64url",
    );
    const recomputed = createHmac("sha256", SECRET)
      .update(`${header}.${forged}`)
      .digest("base64url");
    expect(recomputed).not.toBe(signature);
  });
});

describe("buildSurrealClaims", () => {
  test("carries SurrealDB's required record-access claims plus identity", () => {
    const claims = buildSurrealClaims(
      { userId: "user_abc", orgId: "org_xyz" },
      { nowSeconds: 1_000_000, ttlSeconds: 900 },
    );
    expect(claims.exp).toBe(1_000_900);
    expect(claims.ac).toBe(SURREAL_ACCESS_NAME);
    expect(typeof claims.ns).toBe("string");
    expect(claims.ns.length).toBeGreaterThan(0);
    expect(typeof claims.db).toBe("string");
    expect(claims.user_id).toBe("user_abc");
    expect(claims.org_id).toBe("org_xyz");
  });

  test("carries the id claim that makes the session a RECORD user — table PERMISSIONS only apply to record users", () => {
    const claims = buildSurrealClaims({ userId: "user_abc", orgId: "org_xyz" });
    expect(claims.id).toBe("user:⟨user_abc⟩");
  });

  test("null orgId survives as an explicit null claim", () => {
    const claims = buildSurrealClaims({ userId: "u1", orgId: null });
    expect(claims.org_id).toBeNull();
  });
});

describe("mintSurrealToken", () => {
  test("throws without a configured secret — wiring bug, not soft condition", () => {
    // config.auth.surrealAccessSecret is unset in the test environment.
    expect(() => mintSurrealToken({ userId: "u1", orgId: null })).toThrow(
      "SURREAL_ACCESS_SECRET",
    );
  });

  test("explicit secret mints a decodable token with the full claim set", () => {
    const token = mintSurrealToken(
      { userId: "u1", orgId: "o1" },
      { secret: SECRET, nowSeconds: 2_000_000, ttlSeconds: 60 },
    );
    const payload = decodeSegment(token.split(".")[1] ?? "");
    expect(payload.exp).toBe(2_000_060);
    expect(payload.ac).toBe(SURREAL_ACCESS_NAME);
    expect(payload.user_id).toBe("u1");
    expect(payload.org_id).toBe("o1");
  });
});

describe("buildDefineAccessSql", () => {
  test("targets the database with HS256 and OVERWRITE semantics", () => {
    const sql = buildDefineAccessSql(SECRET);
    expect(sql).toContain(`DEFINE ACCESS OVERWRITE ${SURREAL_ACCESS_NAME}`);
    expect(sql).toContain("ON DATABASE TYPE RECORD WITH JWT ALGORITHM HS256");
    expect(sql).toContain(JSON.stringify(SECRET));
  });

  test("defines RECORD access, never plain JWT — database-level JWT sessions are system-user-equivalent and bypass table PERMISSIONS", () => {
    const sql = buildDefineAccessSql(SECRET);
    expect(sql).toContain("TYPE RECORD WITH JWT");
    expect(sql).not.toContain("TYPE JWT");
  });

  test("quotes and escapes hostile secret characters", () => {
    const sql = buildDefineAccessSql('we"ird\\secret');
    expect(sql).toContain('"we\\"ird\\\\secret"');
  });
});

describe("buildTablePermissionsSql", () => {
  const TABLES = ["memory", "cart_file", "project"];

  test("emits one non-destructive ALTER per table bound to $token.org_id", () => {
    const sql = buildTablePermissionsSql(TABLES);
    const lines = sql.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(TABLES.length);
    for (const table of TABLES) {
      expect(sql).toContain(
        `ALTER TABLE ${table} PERMISSIONS FOR select, create, update, delete WHERE org_id = $token.org_id;`,
      );
    }
  });

  test("uses ALTER, never DEFINE TABLE OVERWRITE (fields must survive)", () => {
    const sql = buildTablePermissionsSql(TABLES);
    expect(sql).not.toContain("DEFINE TABLE");
    expect(sql).not.toContain("OVERWRITE");
  });

  test("binds to the JWT $token claim, not $auth", () => {
    const sql = buildTablePermissionsSql(TABLES);
    expect(sql).toContain("$token.org_id");
    expect(sql).not.toContain("$auth");
  });

  test("empty table list yields empty SQL", () => {
    expect(buildTablePermissionsSql([])).toBe("");
  });
});
