/**
 * First-boot instance claim + signup policy (MIM-70 slice 2).
 *
 * Signup is never open-ended:
 * - ZERO users (unclaimed instance): the claim window. Sign-up succeeds only
 *   when X-Setup-Token matches AUTH_SETUP_TOKEN — closes the deploy→claim
 *   race on a public URL. The first user becomes instance owner and gets an
 *   owner org auto-created from the signup response's own session cookie.
 * - Users exist: sign-up is allowed ONLY for emails holding a pending
 *   organization invitation. A hard-closed signup would strand invited
 *   users at the door — better-auth's acceptInvitation requires an account.
 *
 * Denials are detail-free on the wire (MIM-77 discipline); the specific
 * reason is server-side log material only.
 */

import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import {
  type AppendOrganizationAuditEvent,
  createOrganizationAuditStore,
} from "../audit/store";
import { config } from "../config";
import { grantInitialOperator } from "../operator/state";
import { log } from "../util/logger";
import { attempt } from "../util/result";
import { getAuth, getAuthDb } from "./instance";
import { organizationInvitationTarget } from "./organization-members";
import { SETUP_TOKEN_HEADER, SIGNIN_PATH, SIGNUP_PATH } from "./paths";

const CLOSED_MESSAGE = "Sign-up is closed";

/** Constant-time token comparison via fixed-length SHA-256 digests —
 *  same shape as MIM-77's keyMatches, which this file supersedes. */
export function tokenMatches(presented: string, expected: string) {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Discriminated result of the signup policy — `satisfies` on each return
 *  keeps inference intact while pinning the shape. */
export type SignupDecision =
  | { allow: true; claim: boolean }
  | { allow: false; reason: string };

/**
 * The whole signup policy as one pure function — the guard middleware is
 * just IO feeding this.
 */
export function signupDecision(opts: {
  userCount: number;
  hasPendingInvite: boolean;
  tokenConfigured: boolean;
  tokenValid: boolean;
}) {
  if (opts.userCount === 0) {
    if (!opts.tokenConfigured) {
      return {
        allow: false,
        reason:
          "instance is unclaimed but AUTH_SETUP_TOKEN is not configured — claim impossible",
      } satisfies SignupDecision;
    }
    if (!opts.tokenValid) {
      return {
        allow: false,
        reason: "setup token missing or invalid",
      } satisfies SignupDecision;
    }
    return { allow: true, claim: true } satisfies SignupDecision;
  }
  if (opts.hasPendingInvite) {
    return { allow: true, claim: false } satisfies SignupDecision;
  }
  return {
    allow: false,
    reason: "no pending invitation for this email",
  } satisfies SignupDecision;
}

/** Row-count reads against the auth store. Read-only by contract — writes
 *  stay better-auth's exclusive business. */
export function countUsers(db: Database) {
  const row = db.query('SELECT count(*) AS c FROM "user"').get() as {
    c: number;
  };
  return row.c;
}

export function pendingInviteExists(db: Database, email: string) {
  if (!email) return false;
  const row = db
    .query(
      `SELECT count(*) AS c FROM invitation
        WHERE lower(email) = lower(?) AND status = 'pending'
          AND datetime(expiresAt) > datetime('now')`,
    )
    .get(email) as { c: number };
  return row.c > 0;
}

/** Collapse a signup response's Set-Cookie headers into a Cookie header so
 *  the claim flow can act as the freshly created session. */
export function setCookiesToCookieHeader(setCookies: string[]) {
  return setCookies
    .map((sc) => sc.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

/**
 * Post-claim bootstrap: create the owner org as the new user, using the
 * session cookie the signup response just minted, and make it the session's
 * active org. Failure is logged, not fatal — the claim itself succeeded and
 * an org can be created through the normal API afterward.
 */
export async function bootstrapOwnerOrg(
  signupResponse: { headers: { getSetCookie(): string[] } },
  auth = getAuth(),
) {
  const cookie = setCookiesToCookieHeader(
    signupResponse.headers.getSetCookie(),
  );
  if (!cookie) {
    log.error(
      "claim signup returned no session cookie — owner org not created",
    );
    return;
  }
  const headers = new Headers({ cookie });
  const [createErr, org] = await attempt(() =>
    auth.api.createOrganization({
      body: { name: "Owner", slug: "owner" },
      headers,
    }),
  );
  if (createErr || !org) {
    log.error({ err: createErr }, "owner org creation failed after claim");
    return;
  }

  const [activeErr] = await attempt(() =>
    auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers,
    }),
  );
  if (activeErr) {
    log.warn({ err: activeErr }, "owner org created but not set active");
  }
  log.info({ orgId: org.id }, "instance claimed — owner org created");
}

function sessionUser(value: unknown) {
  if (typeof value !== "object" || value === null || !("user" in value)) {
    return null;
  }
  const user = value.user;
  if (
    typeof user !== "object" ||
    user === null ||
    !("id" in user) ||
    typeof user.id !== "string" ||
    !("email" in user) ||
    typeof user.email !== "string"
  ) {
    return null;
  }
  return { id: user.id, email: user.email };
}

export async function acceptPendingInvitations(
  db: Database,
  response: { headers: { getSetCookie(): string[] } },
  auth = getAuth(),
) {
  const cookie = setCookiesToCookieHeader(response.headers.getSetCookie());
  if (!cookie) return { accepted: 0, failed: 0 };
  const headers = new Headers({ cookie });
  const [sessionError, session] = await attempt(() =>
    auth.api.getSession({ headers }),
  );
  const user = sessionError ? null : sessionUser(session);
  if (!user) return { accepted: 0, failed: 0 };
  const invitations = db
    .query<{ id: string; organizationId: string }, [string]>(
      `SELECT id, organizationId FROM invitation
        WHERE lower(email) = lower(?) AND status = 'pending'
          AND datetime(expiresAt) > datetime('now')
        ORDER BY createdAt, id`,
    )
    .all(user.email);
  let accepted = 0;
  let failed = 0;
  let acceptedOrgId = "";
  const audit = createOrganizationAuditStore(db);
  for (const invitation of invitations) {
    const requestId = crypto.randomUUID();
    const event: Omit<AppendOrganizationAuditEvent, "outcome" | "metadata"> = {
      orgId: invitation.organizationId,
      actorUserId: user.id,
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: organizationInvitationTarget(
        invitation.organizationId,
        user.email,
      ),
      requestId,
    };
    audit.append({ ...event, outcome: "intent" });
    const [error] = await attempt(() =>
      auth.api.acceptInvitation({
        body: { invitationId: invitation.id },
        headers,
      }),
    );
    if (error) {
      failed += 1;
      audit.append({
        ...event,
        outcome: "failed",
        metadata: { reasonCode: "dependency" },
      });
    } else {
      accepted += 1;
      acceptedOrgId ||= invitation.organizationId;
      audit.append({ ...event, outcome: "succeeded" });
    }
  }
  if (accepted > 0 && acceptedOrgId) {
    const [activeError] = await attempt(() =>
      auth.api.setActiveOrganization({
        body: { organizationId: acceptedOrgId },
        headers,
      }),
    );
    if (activeError) {
      log.warn("accepted invitation could not be made the active organization");
    }
  }
  if (failed > 0) {
    log.warn(
      { accepted, failed },
      "some pending invitations were not accepted",
    );
  }
  return { accepted, failed };
}

async function grantClaimedOperator(
  db: Database,
  response: { headers: { getSetCookie(): string[] } },
  auth: ReturnType<typeof getAuth>,
) {
  const cookie = setCookiesToCookieHeader(response.headers.getSetCookie());
  if (!cookie) return false;
  const [sessionError, session] = await attempt(() =>
    auth.api.getSession({ headers: new Headers({ cookie }) }),
  );
  const user = sessionError ? null : sessionUser(session);
  return user ? grantInitialOperator(db, user.id) : false;
}

/**
 * Hono middleware guarding the email signup endpoint. Mounted on
 * The sign-up API path before the better-auth handler; everything except POST
 * passes through untouched.
 */
interface ClaimGuardOptions {
  db?: Database;
  setupToken?: string;
  bootstrap?: typeof bootstrapOwnerOrg;
  auth?: ReturnType<typeof getAuth>;
}

export const createClaimGuard =
  (options: ClaimGuardOptions = {}) =>
  async (c: Context, next: Next) => {
    if (c.req.method !== "POST") return next();

    if (c.req.path === SIGNIN_PATH) {
      await next();
      if (c.res.status === 200) {
        await acceptPendingInvitations(
          options.db ?? getAuthDb(),
          c.res.clone(),
          options.auth ?? getAuth(),
        );
      }
      return;
    }
    if (c.req.path !== SIGNUP_PATH) return next();

    const db = options.db ?? getAuthDb();
    const setupToken = options.setupToken ?? config.auth.setupToken;
    const users = countUsers(db);

    // Body email only matters for the invite check — a clone() read so the
    // real handler still gets an unconsumed stream. Unparseable body → no
    // email → no invite match; better-auth 400s it properly downstream.
    let email = "";
    if (users > 0) {
      const [, body] = await attempt(
        () => c.req.raw.clone().json() as Promise<{ email?: string }>,
      );
      email = typeof body?.email === "string" ? body.email : "";
    }

    const decision = signupDecision({
      userCount: users,
      hasPendingInvite: users > 0 && pendingInviteExists(db, email),
      tokenConfigured: setupToken.length > 0,
      tokenValid: tokenMatches(
        c.req.header(SETUP_TOKEN_HEADER) ?? "",
        setupToken,
      ),
    });

    if (!decision.allow) {
      log.warn({ reason: decision.reason }, "signup rejected");
      return c.json({ error: { message: CLOSED_MESSAGE } }, 403);
    }

    await next();

    if (decision.claim && c.res.status === 200) {
      await (options.bootstrap ?? bootstrapOwnerOrg)(c.res.clone());
      const [grantError, granted] = await attempt(() =>
        grantClaimedOperator(db, c.res.clone(), options.auth ?? getAuth()),
      );
      if (grantError || !granted) {
        log.error(
          { err: grantError },
          "claimed account could not be granted instance-operator access",
        );
      }
    } else if (c.res.status === 200) {
      await acceptPendingInvitations(
        db,
        c.res.clone(),
        options.auth ?? getAuth(),
      );
    }
  };
