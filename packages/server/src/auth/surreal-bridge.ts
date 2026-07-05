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
 * Assemble the claim set SurrealDB requires for database-level JWT access
 * (exp/ac/ns/db) plus the identity claims MIM-69's PERMISSIONS consume.
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
 */
export function buildDefineAccessSql(secret: string) {
  return `DEFINE ACCESS OVERWRITE ${SURREAL_ACCESS_NAME} ON DATABASE TYPE JWT ALGORITHM HS256 KEY ${JSON.stringify(secret)};`;
}
