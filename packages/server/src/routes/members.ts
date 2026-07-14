import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getAuthDb } from "../auth/instance";
import { changeOrganizationMemberRole } from "../auth/membership";
import { config } from "../config";
import type { IdentityEnv } from "../middleware/identity";
import { isTrustedRecentBrowser } from "../middleware/recent-browser";
import { attempt } from "../util/result";

const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;

interface MemberRouteOptions {
  origin?: string;
  now?: () => number;
}

function requestId(value: string | undefined) {
  return value && OPAQUE_ID.test(value) ? value : crypto.randomUUID();
}

function organizationRole(value: unknown) {
  return value === "owner" || value === "admin" || value === "member"
    ? value
    : null;
}

export function createMembersRoutes(
  getDb: () => Database = getAuthDb,
  options: MemberRouteOptions = {},
) {
  const members = new Hono<IdentityEnv>();
  const origin = options.origin ?? new URL(config.auth.baseUrl).origin;

  members.post("/role", async (c) => {
    const identity = c.get("identity");
    if (
      !identity ||
      !isTrustedRecentBrowser(c, origin, options.now ?? Date.now)
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const [parseError, body] = await attempt(
      () => c.req.json() as Promise<Record<string, unknown>>,
    );
    if (parseError) return c.json({ error: "Invalid request" }, 400);
    const memberId =
      typeof body.memberId === "string" && OPAQUE_ID.test(body.memberId)
        ? body.memberId
        : null;
    const role = organizationRole(body.role);
    if (!memberId || !role) {
      return c.json({ error: "Invalid request" }, 400);
    }

    const result = changeOrganizationMemberRole(getDb(), {
      orgId: identity.orgId,
      actorUserId: identity.userId,
      memberId,
      role,
      requestId: requestId(c.req.header("x-request-id")),
    });
    if (result === "changed") return c.json({ ok: true, changed: true });
    if (result === "unchanged") return c.json({ ok: true, changed: false });
    if (result === "conflict") return c.json({ error: "Conflict" }, 409);
    if (result === "not_found") return c.json({ error: "Not found" }, 404);
    return c.json({ error: "Forbidden" }, 403);
  });

  return members;
}

export const members = createMembersRoutes();
