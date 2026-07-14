import type { Context, Next } from "hono";
import { signInLocation } from "../web/paths";
import {
  type IdentityEnv,
  lookupIdentity,
  type MembershipLookup,
  type OrgLister,
  requestAuthHeaders,
  resolveIdentity,
  type SessionLookup,
} from "./identity";

export const createRootRedirect =
  (lookup?: SessionLookup) => async (c: Context<IdentityEnv>) => {
    c.header("cache-control", "private, no-store");
    const identity = await lookupIdentity(requestAuthHeaders(c), lookup);
    return c.redirect(identity ? "/app" : "/sign-in");
  };

export const createWebAccessGate =
  (
    lookup?: SessionLookup,
    listOrgs?: OrgLister,
    lookupMembership?: MembershipLookup,
  ) =>
  async (c: Context<IdentityEnv>, next: Next) => {
    c.header("cache-control", "private, no-store");
    const resolution = await resolveIdentity(
      requestAuthHeaders(c),
      lookup,
      listOrgs,
      lookupMembership,
    );
    if (!resolution.identity) {
      if (resolution.status === 401) {
        return c.redirect(signInLocation(c.req.url));
      }
      return c.text("Forbidden", 403);
    }

    c.set("identity", resolution.identity);
    return next();
  };
