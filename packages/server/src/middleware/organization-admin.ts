import type { Context, Next } from "hono";
import { getAuth } from "../auth/instance";
import { attempt } from "../util/result";
import { signInLocation } from "../web/paths";
import {
  type IdentityEnv,
  lookupIdentity,
  type ResolvedIdentity,
  type SessionLookup,
} from "./identity";

export type ActiveMemberLookup = (headers: Headers) => Promise<unknown>;

const ADMIN_ROLES = new Set(["owner", "admin"]);

const defaultActiveMemberLookup: ActiveMemberLookup = (headers) =>
  getAuth().api.getActiveMember({ headers });

function browserHeaders(c: Context<IdentityEnv>) {
  if (c.req.header("authorization") || c.req.header("x-api-key")) return null;
  const cookie = c.req.header("cookie");
  if (!cookie) return null;
  return new Headers({ cookie });
}

function readRoles(value: unknown) {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.flatMap((role) =>
    typeof role === "string" && role ? [role] : [],
  );
}

export function readOrganizationMembership(
  value: unknown,
  identity: ResolvedIdentity,
) {
  if (typeof value !== "object" || value === null) return null;
  if (!("userId" in value) || value.userId !== identity.userId) return null;
  if (!("organizationId" in value) || value.organizationId !== identity.orgId) {
    return null;
  }
  if (!("role" in value)) return null;
  const organizationRoles = readRoles(value.role);
  if (organizationRoles.length === 0) return null;
  return { ...identity, organizationRoles } satisfies ResolvedIdentity;
}

export function canManageOrganization(identity: ResolvedIdentity | undefined) {
  return Boolean(
    identity?.organizationRoles?.some((role) => ADMIN_ROLES.has(role)),
  );
}

async function enrichIdentity(
  identity: ResolvedIdentity,
  headers: Headers,
  lookup: ActiveMemberLookup,
) {
  const [error, member] = await attempt(() => lookup(headers));
  return error ? null : readOrganizationMembership(member, identity);
}

export const createOrganizationRoleEnrichment =
  (lookup: ActiveMemberLookup = defaultActiveMemberLookup) =>
  async (c: Context<IdentityEnv>, next: Next) => {
    const identity = c.get("identity");
    const headers = browserHeaders(c);
    if (identity && headers) {
      const enriched = await enrichIdentity(identity, headers, lookup);
      if (enriched) c.set("identity", enriched);
    }
    return next();
  };

export const createOrganizationAdminGate =
  (
    sessionLookup?: SessionLookup,
    memberLookup: ActiveMemberLookup = defaultActiveMemberLookup,
  ) =>
  async (c: Context<IdentityEnv>, next: Next) => {
    c.header("cache-control", "private, no-store");
    if (c.req.header("authorization") || c.req.header("x-api-key")) {
      return c.text("Forbidden", 403);
    }

    const headers = browserHeaders(c);
    if (!headers) return c.redirect(signInLocation(c.req.url));

    const sessionIdentity = await lookupIdentity(headers, sessionLookup);
    if (!sessionIdentity) return c.redirect(signInLocation(c.req.url));
    if (!sessionIdentity.orgId) return c.text("Forbidden", 403);

    const identity = await enrichIdentity(
      { userId: sessionIdentity.userId, orgId: sessionIdentity.orgId },
      headers,
      memberLookup,
    );
    if (!identity || !canManageOrganization(identity)) {
      return c.text("Forbidden", 403);
    }

    c.set("identity", identity);
    return next();
  };
