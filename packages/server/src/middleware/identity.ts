/**
 * Better-auth identity gate (MIM-70 slice 2) — replaces MIM-77's static
 * bearer gate as the ONLY request gating when auth is enabled.
 *
 * Credential surfaces accepted:
 * - Cookie: browser/dashboard sessions, passed through untouched.
 * - x-api-key: better-auth api-key plugin's native header.
 * - Authorization: Bearer <key>: the header every existing machine client
 *   (cc-plugin authHeaders(), ACP adapter) already sends — surfaced to
 *   better-auth as x-api-key so client wiring stays unchanged, they just
 *   carry better-auth-minted keys now.
 *
 * 401s are detail-free (MIM-77 discipline). /health stays exempt for
 * credential-less healthchecks; /api/auth/* self-gates (and the signup
 * path carries its own claim guard).
 */

import type { Context, Next } from "hono";
import { getAuth } from "../auth/instance";
import { attempt } from "../util/result";

const BEARER_PREFIX = "Bearer ";
const API_KEY_HEADER = "x-api-key";
/** Exact-match exemptions — deliberately case-sensitive, no trailing-slash
 *  tolerance (MIM-77's conservative posture). */
const EXEMPT_PATHS = new Set(["/health"]);
const AUTH_PATH_PREFIX = "/api/auth/";

/**
 * Map inbound credentials onto headers better-auth understands. Pure —
 * tested directly. An explicit x-api-key wins over Authorization; cookies
 * always pass through.
 */
export function toAuthHeaders(input: {
  cookie?: string;
  authorization?: string;
  apiKey?: string;
}) {
  const headers = new Headers();
  if (input.cookie) {
    headers.set("cookie", input.cookie);
  }
  const bearer = input.authorization?.startsWith(BEARER_PREFIX)
    ? input.authorization.slice(BEARER_PREFIX.length).trim()
    : "";
  const apiKey = input.apiKey || bearer;
  if (apiKey) {
    headers.set(API_KEY_HEADER, apiKey);
  }
  return headers;
}

/** Session lookup shape the gate depends on — injectable so tests never
 *  touch the config-driven singleton (which would create a SQLite file). */
type SessionLookup = (headers: Headers) => Promise<unknown>;

const defaultLookup: SessionLookup = (headers) =>
  getAuth().api.getSession({ headers });

/**
 * Build the gate middleware. Mounted app-wide (after the auth handler
 * routes) only when config.auth.enabled — index.ts owns that decision.
 */
export const createIdentityGate =
  (lookup: SessionLookup = defaultLookup) =>
  async (c: Context, next: Next) => {
    const path = c.req.path;
    if (EXEMPT_PATHS.has(path) || path.startsWith(AUTH_PATH_PREFIX)) {
      return next();
    }

    const headers = toAuthHeaders({
      cookie: c.req.header("cookie"),
      authorization: c.req.header("authorization"),
      apiKey: c.req.header(API_KEY_HEADER),
    });

    // Invalid/expired keys can reject rather than resolve null — either
    // way the answer is the same detail-free 401.
    const [err, session] = await attempt(() => lookup(headers));
    if (err || !session) {
      return c.json({ error: { message: "Unauthorized" } }, 401);
    }

    return next();
  };
