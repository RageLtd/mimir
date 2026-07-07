/**
 * Better Auth → SurrealDB record-access bridge (MIM-70 slice 4).
 *
 * Mints short-lived HS256 JWTs from a resolved identity so requests can run
 * on Surreal sessions that carry `$token.user_id` / `$token.org_id` claims.
 * MIM-69 binds row-level security to them (`PERMISSIONS WHERE org_id =
 * $token.org_id`) — until then the access method is defined but dormant.
 *
 * The signer is hand-rolled on node:crypto — an HS256 JWT is two base64url
 * segments and an HMAC; a dependency would be more code than this file.
 * SurrealDB's database-level JWT contract (per their DEFINE ACCESS docs):
 * claims MUST carry exp, ac (access method name), ns, and db.
 */

import { createHmac } from "node:crypto";
import { config } from "../config";

/** Access method name — referenced by DEFINE ACCESS, token `ac` claims,
 *  and (in MIM-69) PERMISSIONS definitions. */
export const SURREAL_ACCESS_NAME = "mimir_user";

/** Short-lived by design: tokens are minted per request/turn, not stored. */
const DEFAULT_TTL_SECONDS = 900;

const b64url = (input: string) => Buffer.from(input).toString("base64url");

/** Minimal HS256 JWT signer. Pure — tested by recomputing the signature. */
export function signJwtHs256(payload: Record<string, unknown>, secret: string) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

export interface SurrealIdentityClaims {
  userId: string;
  orgId: string | null;
}

/**
 * Assemble the claim set SurrealDB requires for record access with JWT
 * (exp/ac/ns/db/id) plus the identity claims MIM-69's PERMISSIONS consume.
 *
 * The `id` claim is what makes the session a RECORD user — table and field
 * PERMISSIONS apply exclusively to record users; without it the session is
 * system-user-equivalent and bypasses them entirely (the MIM-69 smoke caught
 * exactly this). The record it names lives in Better Auth's sqlite, not in
 * Surreal, so `$auth.*` is empty by design — the PERMISSIONS predicate binds
 * to `$token.org_id`, never `$auth`.
 */
export function buildSurrealClaims(
  identity: SurrealIdentityClaims,
  opts: { nowSeconds?: number; ttlSeconds?: number } = {},
) {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    ac: SURREAL_ACCESS_NAME,
    ns: config.surreal.namespace,
    db: config.surreal.database,
    id: `user:⟨${identity.userId}⟩`,
    user_id: identity.userId,
    org_id: identity.orgId,
  };
}

/**
 * Mint a scoped-session token for a resolved identity. Throws when the
 * bridge secret is unconfigured — a caller reaching for a scoped session
 * on an unbridged deployment is a wiring bug, not a soft condition.
 */
export function mintSurrealToken(
  identity: SurrealIdentityClaims,
  opts: { secret?: string; nowSeconds?: number; ttlSeconds?: number } = {},
) {
  const secret = opts.secret ?? config.auth.surrealAccessSecret;
  if (!secret) {
    throw new Error(
      "SURREAL_ACCESS_SECRET is not configured — cannot mint a scoped Surreal token",
    );
  }
  return signJwtHs256(buildSurrealClaims(identity, opts), secret);
}

/**
 * The DEFINE ACCESS statement initSchema applies when the bridge secret is
 * configured. OVERWRITE (not IF NOT EXISTS) so secret rotation takes effect
 * on the next boot instead of being silently ignored.
 *
 * TYPE RECORD WITH JWT — NOT plain TYPE JWT. Per the SurrealDB docs, access
 * granted by a database-level JWT access method "is equivalent to that of
 * system users, bypassing fine-grained permissions": reads would see every
 * org's rows. Only record users are subject to table PERMISSIONS, and record
 * access requires the token's `id` claim (buildSurrealClaims above).
 */
export function buildDefineAccessSql(secret: string) {
  return `DEFINE ACCESS OVERWRITE ${SURREAL_ACCESS_NAME} ON DATABASE TYPE RECORD WITH JWT ALGORITHM HS256 KEY ${JSON.stringify(secret)};`;
}

/**
 * Row-level org PERMISSIONS applied to every tenant table when the bridge
 * secret is configured (MIM-69 slice 5). ALTER TABLE — not DEFINE TABLE
 * OVERWRITE — so the existing DEFINE FIELD and index definitions survive
 * untouched. The predicate binds to `$token.org_id`, the custom claim
 * buildSurrealClaims mints (JWT record access exposes claims under `$token`,
 * not `$auth`). Only the scoped mimir_user sessions are subject to these; the
 * root connection bypasses table permissions by Surreal design.
 */
export function buildTablePermissionsSql(tables: readonly string[]) {
  return tables
    .map(
      (table) =>
        `ALTER TABLE ${table} PERMISSIONS FOR select, create, update, delete WHERE org_id = $token.org_id;`,
    )
    .join("\n");
}
