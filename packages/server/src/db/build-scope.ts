/**
 * Request-scope construction (MIM-69) — mint a bridge JWT for a resolved
 * identity and open a scoped Surreal session on it.
 *
 * Kept out of scope.ts (the leaf) so the connect/mint dependency on surreal.ts
 * + surreal-bridge.ts never forms a cycle with the migration chain
 * (surreal → migrate-org-scope → scope). Nothing in that chain imports this
 * file — only the request layer (ingress routes, /mcp) does.
 *
 * Connect-per-request (Rage's call, MIM-69): the caller owns the returned
 * scope's connection and MUST close it (`scope.db.close()`) in a finally.
 * Per-org connection pooling is the named fast-follow if the handshake cost
 * bites; nothing here forecloses it.
 */

import { mintSurrealToken } from "../auth/surreal-bridge";
import type { OrgScope } from "./scope";
import { connectScoped } from "./surreal";

export interface ResolvedIdentity {
  userId: string;
  orgId: string;
}

/**
 * Build a request scope: mint a short-lived JWT carrying the identity's
 * user/org claims, open a scoped session authenticated with it, and hand back
 * an OrgScope over that connection. Throws if the bridge secret is
 * unconfigured (mintSurrealToken) or the connection fails — both are wiring
 * faults the caller surfaces, not silent degradations.
 */
export async function buildScope(identity: ResolvedIdentity) {
  const token = mintSurrealToken({
    userId: identity.userId,
    orgId: identity.orgId,
  });
  const db = await connectScoped(token);
  return { orgId: identity.orgId, db, isRoot: false } satisfies OrgScope;
}
