import type { Context, Next } from "hono";
import { getAuth, getAuthDb } from "../auth/instance";
import { OPERATOR_PATH_PREFIX, OPERATOR_ROOT_PATH } from "../operator/paths";
import { hasOperatorGrant } from "../operator/state";
import { attempt } from "../util/result";
import { signInLocation } from "../web/paths";
import {
  type IdentityEnv,
  lookupIdentity,
  type SessionLookup,
} from "./identity";

export const isOperatorBrowserPath = (path: string) =>
  path === OPERATOR_ROOT_PATH || path.startsWith(OPERATOR_PATH_PREFIX);

export type OperatorGrantLookup = (
  userId: string,
) => Promise<boolean> | boolean;

const defaultSessionLookup: SessionLookup = (headers) =>
  getAuth().api.getSession({ headers });

const defaultGrantLookup: OperatorGrantLookup = (userId) =>
  hasOperatorGrant(getAuthDb(), userId);

function browserHeaders(c: Context<IdentityEnv>) {
  if (c.req.header("authorization") || c.req.header("x-api-key")) return null;
  const cookie = c.req.header("cookie");
  return cookie ? new Headers({ cookie }) : null;
}

export const createOperatorBrowserGate =
  (
    sessionLookup: SessionLookup = defaultSessionLookup,
    grantLookup: OperatorGrantLookup = defaultGrantLookup,
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

    const [grantError, granted] = await attempt(() =>
      Promise.resolve(grantLookup(sessionIdentity.userId)),
    );
    if (grantError || !granted) return c.text("Forbidden", 403);

    c.set("operatorIdentity", {
      userId: sessionIdentity.userId,
      ...(sessionIdentity.authenticatedAt === undefined
        ? {}
        : { authenticatedAt: sessionIdentity.authenticatedAt }),
    });
    return next();
  };

export const createOperatorNavigationEnrichment =
  (grantLookup: OperatorGrantLookup = defaultGrantLookup) =>
  async (c: Context<IdentityEnv>, next: Next) => {
    const identity = c.get("identity");
    const headers = browserHeaders(c);
    if (!identity || !headers) return next();

    const [grantError, granted] = await attempt(() =>
      Promise.resolve(grantLookup(identity.userId)),
    );
    if (!grantError && granted) c.set("operatorNavigation", true);
    return next();
  };
