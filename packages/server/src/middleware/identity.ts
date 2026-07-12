/**
 * Better-auth identity gate (MIM-70 slice 2; MIM-69 slice 3 adds org
 * resolution) — the ONLY request gating when auth is enabled.
 *
 * Credential surfaces accepted:
 * - Cookie: browser/dashboard sessions, passed through untouched.
 * - x-api-key: better-auth api-key plugin's native header.
 * - Authorization: Bearer <key>: the header every existing machine client
 *   (cc-plugin authHeaders(), ACP adapter) already sends — surfaced to
 *   better-auth as x-api-key so client wiring stays unchanged, they just
 *   carry better-auth-minted keys now.
 *
 * On a valid session the gate resolves the request's org (MIM-69) and stashes
 * a ResolvedIdentity on the Hono context; downstream routes read it via
 * scopeOrgId to scope every store access. A session with no active
 * organization falls back to the user's sole membership; a user in zero or
 * many orgs with none active is rejected (they must pick one first).
 *
 * 401/403s are detail-free (MIM-77 discipline). /health stays exempt for
 * credential-less healthchecks; /api/auth/* self-gates (and the signup path
 * carries its own claim guard). Browser exemptions are supplied by app.ts so
 * this API-oriented module does not own the web route policy.
 */

import type { Context, Next } from "hono";
import { getAuth } from "../auth/instance";
import { OWNER_ORG_SENTINEL } from "../db/tenant";
import { log } from "../util/logger";
import { attempt } from "../util/result";

/** A resolved request identity — the user and the org their request is
 *  scoped to (relocated from db/scope.ts when Surreal exited, MIM-88). */
export interface ResolvedIdentity {
  readonly userId: string;
  readonly orgId: string;
}

const BEARER_PREFIX = "Bearer ";
const API_KEY_HEADER = "x-api-key";
/** Exact-match exemptions — deliberately case-sensitive, no trailing-slash
 *  tolerance (MIM-77's conservative posture). */
const EXEMPT_PATHS = new Set(["/health"]);
const AUTH_PATH_PREFIX = "/api/auth/";

/** Hono context environment: the gate sets `identity`, routes read it. Optional
 *  because an auth-off boot never mounts the gate, so it may be unset. */
export interface IdentityEnv {
  Variables: { identity?: ResolvedIdentity };
}

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

/**
 * Narrow an opaque getSession result to {userId, orgId?}. The lookup is typed
 * `unknown` on purpose (so tests never touch the config singleton), so this is
 * the validation boundary — property-check narrowing, no casts.
 */
export function readIdentity(session: unknown) {
  if (typeof session !== "object" || session === null) return null;
  if (!("user" in session)) return null;
  const user = session.user;
  if (typeof user !== "object" || user === null || !("id" in user)) return null;
  const userId = user.id;
  if (typeof userId !== "string") return null;

  let orgId: string | null = null;
  if ("session" in session) {
    const inner = session.session;
    if (
      typeof inner === "object" &&
      inner !== null &&
      "activeOrganizationId" in inner &&
      typeof inner.activeOrganizationId === "string"
    ) {
      orgId = inner.activeOrganizationId;
    }
  }
  return { userId, orgId };
}

/** The lone organization id from a list result, or null when the user belongs
 *  to zero or more than one — validation boundary, no casts. */
export function pickSoleOrg(orgs: unknown) {
  if (!Array.isArray(orgs) || orgs.length !== 1) return null;
  const org: unknown = orgs[0];
  if (
    typeof org === "object" &&
    org !== null &&
    "id" in org &&
    typeof org.id === "string"
  ) {
    return org.id;
  }
  return null;
}

/** Session/org lookups the gate depends on — injectable so tests never touch
 *  the config-driven singleton (which would create a SQLite file). */
export type SessionLookup = (headers: Headers) => Promise<unknown>;
export type OrgLister = (headers: Headers) => Promise<unknown>;
export type PathExemption = (path: string) => boolean;

type IdentityResolution =
  | { identity: ResolvedIdentity; status: null }
  | { identity: null; status: 401 }
  | { identity: null; status: 403; userId: string };

const defaultLookup: SessionLookup = (headers) =>
  getAuth().api.getSession({ headers });
const defaultListOrgs: OrgLister = (headers) =>
  getAuth().api.listOrganizations({ headers });

export function requestAuthHeaders(c: Context) {
  return toAuthHeaders({
    cookie: c.req.header("cookie"),
    authorization: c.req.header("authorization"),
    apiKey: c.req.header(API_KEY_HEADER),
  });
}

export async function lookupIdentity(
  headers: Headers,
  lookup: SessionLookup = defaultLookup,
) {
  const [err, session] = await attempt(() => lookup(headers));
  if (err) return null;
  return readIdentity(session);
}

export async function resolveIdentity(
  headers: Headers,
  lookup: SessionLookup = defaultLookup,
  listOrgs: OrgLister = defaultListOrgs,
) {
  const identity = await lookupIdentity(headers, lookup);
  if (!identity) {
    return { identity: null, status: 401 } satisfies IdentityResolution;
  }

  let orgId = identity.orgId;
  if (!orgId) {
    const [orgErr, orgs] = await attempt(() => listOrgs(headers));
    const sole = orgErr ? null : pickSoleOrg(orgs);
    if (!sole) {
      return {
        identity: null,
        status: 403,
        userId: identity.userId,
      } satisfies IdentityResolution;
    }
    orgId = sole;
  }

  return {
    identity: { userId: identity.userId, orgId },
    status: null,
  } satisfies IdentityResolution;
}

/**
 * Build the API gate middleware. Mounted app-wide after the browser boundary
 * only when config.auth.enabled — app.ts owns that composition decision.
 */
export const createIdentityGate =
  (
    lookup: SessionLookup = defaultLookup,
    listOrgs: OrgLister = defaultListOrgs,
    isExempt: PathExemption = () => false,
  ) =>
  async (c: Context<IdentityEnv>, next: Next) => {
    const path = c.req.path;
    if (
      EXEMPT_PATHS.has(path) ||
      path.startsWith(AUTH_PATH_PREFIX) ||
      isExempt(path) ||
      c.get("identity")
    ) {
      return next();
    }

    const resolution = await resolveIdentity(
      requestAuthHeaders(c),
      lookup,
      listOrgs,
    );
    if (!resolution.identity) {
      if (resolution.status === 403) {
        log.warn(
          { userId: resolution.userId },
          "identity gate: no active organization and no sole membership — rejecting",
        );
      }
      const message = resolution.status === 401 ? "Unauthorized" : "Forbidden";
      return c.json({ error: { message } }, resolution.status);
    }

    c.set("identity", resolution.identity);
    return next();
  };

/**
 * The org id a route should scope its store access to. Reads the gate-stashed
 * identity; falls back to the owner sentinel when auth is off (no gate ran) so
 * the self-hosted single-org path is unchanged.
 */
export function scopeOrgId<E extends IdentityEnv>(c: Context<E>) {
  return c.get("identity")?.orgId ?? OWNER_ORG_SENTINEL;
}
