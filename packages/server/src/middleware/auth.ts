/**
 * Interim static bearer-key gate (MIM-77).
 *
 * Deliberately NOT user auth: a shared-secret gate so a publicly reachable
 * deployment answers only to holders of an operator-minted key until
 * MIM-70's real auth (users/orgs, Better Auth) supersedes it. Keys are
 * static, comma-separated in MIMIR_API_KEYS — one per client so they can
 * be revoked individually.
 *
 * GET /health stays open: Railway/compose healthchecks and uptime probes
 * carry no credentials, and it exposes service status only.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

const BEARER_PREFIX = "Bearer ";

/** Paths served without a key. */
const EXEMPT_PATHS = new Set(["/health"]);

/**
 * Constant-time membership check. Comparing SHA-256 digests (fixed equal
 * length) lets timingSafeEqual run on every candidate without leaking
 * key length; `some` short-circuits only on a genuine match, which is
 * the acceptable timing signal (an attacker learning THAT they matched).
 */
export const keyMatches = (presented: string, keys: readonly string[]) => {
  const presentedDigest = createHash("sha256").update(presented).digest();
  return keys.some((key) =>
    timingSafeEqual(presentedDigest, createHash("sha256").update(key).digest()),
  );
};

/**
 * Build the gate middleware for a non-empty key set. Callers (index.ts)
 * mount it only when keys are configured — an empty key set means the
 * operator chose an ungated deployment (self-hosted default) and gets a
 * loud boot warning instead of silent exposure.
 */
export const createBearerGate =
  (keys: readonly string[]) => async (c: Context, next: Next) => {
    if (EXEMPT_PATHS.has(c.req.path)) return next();

    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length).trim()
      : "";

    if (!presented || !keyMatches(presented, keys)) {
      // No detail on purpose — don't confirm whether the header was
      // missing, malformed, or wrong.
      return c.json({ error: { message: "Unauthorized" } }, 401);
    }

    return next();
  };
