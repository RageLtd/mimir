import type { Context } from "hono";
import type { IdentityEnv } from "./identity";

export const RECENT_AUTH_MAX_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export function isTrustedRecentBrowser(
  c: Context<IdentityEnv>,
  origin: string,
  now: () => number = Date.now,
) {
  if (c.req.header("authorization") || c.req.header("x-api-key")) return false;
  if (!c.req.header("cookie") || c.req.header("origin") !== origin)
    return false;
  const authenticatedAt = c.get("identity")?.authenticatedAt;
  if (authenticatedAt === undefined) return false;
  const age = now() - authenticatedAt;
  return age >= -CLOCK_SKEW_MS && age <= RECENT_AUTH_MAX_AGE_MS;
}
