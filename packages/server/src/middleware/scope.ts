/**
 * Request-scope middleware (MIM-69 slice 5).
 *
 * Owns the connect-per-request lifecycle in ONE place so route handlers never
 * open or close a connection themselves. Builds the scope from the gate-stashed
 * identity, stashes it on the context for `c.get("scope")`, and closes it once
 * the handler has produced its response.
 *
 * This is a `finally`, not a `catch`: a handler error propagates untouched to
 * Hono's error boundary (becoming a 500) — the `finally` only guarantees the
 * scoped connection is released so it can't leak on an error path. `closeScope`
 * is a no-op on the shared root connection (auth-off), so this is inert there.
 *
 * NOT for the streaming ingress routes: their SSE response outlives `next()`,
 * so the connection must close in the stream finalizer, not here (closing after
 * `next()` would sever the stream mid-turn). Only non-streaming routes that read
 * `c.get("scope")` mount this.
 */

import type { Context, Next } from "hono";
import { requestScope } from "../db/build-scope";
import { closeScope, type OrgScope, OWNER_ORG_SENTINEL } from "../db/scope";
import type { IdentityEnv } from "./identity";

export interface ScopedEnv {
  Variables: IdentityEnv["Variables"] & { scope: OrgScope };
}

export const scopeMiddleware = async (c: Context<ScopedEnv>, next: Next) => {
  const identity = c.get("identity");
  const scope = await requestScope(
    identity,
    identity?.orgId ?? OWNER_ORG_SENTINEL,
  );
  c.set("scope", scope);
  try {
    await next();
  } finally {
    await closeScope(scope);
  }
};
