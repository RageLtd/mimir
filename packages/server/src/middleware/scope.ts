/**
 * Request-scope middleware — post-Surreal edition (MIM-88).
 *
 * The scope used to carry a per-request SurrealDB connection; with the
 * tenant store on SQLite (shared handle, WHERE-clause isolation) it
 * reduces to the org id the identity gate resolved. Kept as middleware —
 * rather than every route calling scopeOrgId — so the store layer keeps
 * a required scope argument the compiler enforces (the MIM-69 spine:
 * forgetting to scope a query is a compile error, not a leak).
 */

import type { Context, Next } from "hono";
import { OWNER_ORG_SENTINEL } from "../db/tenant";
import type { IdentityEnv } from "./identity";

export interface OrgScope {
  readonly orgId: string;
}

export interface ScopedEnv {
  Variables: IdentityEnv["Variables"] & { scope: OrgScope };
}

export const scopeMiddleware = async (c: Context<ScopedEnv>, next: Next) => {
  const identity = c.get("identity");
  c.set("scope", { orgId: identity?.orgId ?? OWNER_ORG_SENTINEL });
  await next();
};
