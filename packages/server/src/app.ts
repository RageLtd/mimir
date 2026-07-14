import { Hono } from "hono";
import { cors } from "hono/cors";
import { createOrganizationAuditStore } from "./audit/store";
import { createClaimGuard } from "./auth/claim";
import { getAuth, getAuthDb } from "./auth/instance";
import {
  createOrganizationInvitation,
  listOrganizationMembers,
  reissueOrganizationInvitation,
  revokeOrganizationInvitation,
} from "./auth/organization-members";
import { SIGNIN_PATH, SIGNUP_PATH } from "./auth/paths";
import { config } from "./config";
import { getTenantDb } from "./db/tenant";
import {
  createIdentityGate,
  type IdentityEnv,
  type MembershipLookup,
  type OrgLister,
  type SessionLookup,
} from "./middleware/identity";
import { createOperatorGate, isOperatorPath } from "./middleware/operator";
import {
  type ActiveMemberLookup,
  createOrganizationAdminGate,
  createOrganizationRoleEnrichment,
} from "./middleware/organization-admin";
import {
  createRootRedirect,
  createWebAccessGate,
} from "./middleware/web-access";
import { type createKeysRoutes, keys } from "./routes/keys";
import { mcp } from "./routes/mcp";
import { type createMembersRoutes, members } from "./routes/members";
import { sync } from "./routes/sync";
import { systemPrompt } from "./routes/system-prompt";
import { log } from "./util/logger";
import { attemptSync } from "./util/result";
import { createWeb } from "./web";
import type { OrganizationAuditList } from "./web/activity";
import type { OrganizationMembersOptions } from "./web/members";
import { isPublicWebPath } from "./web/paths";

const CONTROLLED_ORGANIZATION_MUTATIONS = new Set([
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/leave",
]);

interface AppOptions {
  authEnabled?: boolean;
  authHandler?: ReturnType<typeof getAuth>["handler"];
  claimGuard?: ReturnType<typeof createClaimGuard>;
  sessionLookup?: SessionLookup;
  orgLister?: OrgLister;
  membershipLookup?: MembershipLookup;
  activeMemberLookup?: ActiveMemberLookup;
  organizationAuditList?: OrganizationAuditList;
  organizationMembers?: OrganizationMembersOptions;
  keyRoutes?: ReturnType<typeof createKeysRoutes>;
  memberRoutes?: ReturnType<typeof createMembersRoutes>;
  operatorToken?: string;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<IdentityEnv>();
  const authEnabled = options.authEnabled ?? config.auth.enabled;
  let auditStore: ReturnType<typeof createOrganizationAuditStore> | null = null;
  const organizationAuditList: OrganizationAuditList =
    options.organizationAuditList ??
    ((orgId, filters) => {
      auditStore ??= createOrganizationAuditStore(getAuthDb());
      return auditStore.list(orgId, filters);
    });
  const activeMemberLookup = options.activeMemberLookup;
  const membershipLookup =
    options.membershipLookup ??
    (activeMemberLookup
      ? (_identity: { userId: string; orgId: string }, headers: Headers) =>
          activeMemberLookup(headers)
      : undefined);
  const organizationMembers: OrganizationMembersOptions =
    options.organizationMembers ?? {
      origin: new URL(config.auth.baseUrl).origin,
      list: (orgId, filters) =>
        listOrganizationMembers(getAuthDb(), orgId, filters),
      invite: (input, headers) =>
        createOrganizationInvitation(getAuthDb(), getAuth(), input, headers),
      revokeInvitation: (input, headers) =>
        revokeOrganizationInvitation(getAuthDb(), getAuth(), input, headers),
      reissueInvitation: (input, headers) =>
        reissueOrganizationInvitation(getAuthDb(), getAuth(), input, headers),
      request: (path, init) => app.request(path, init),
    };

  app.use("*", cors());
  app.use("*", createOperatorGate(options.operatorToken));

  // Better Auth (MIM-70) — the ONLY gating mechanism. Mount order matters:
  // the claim guard wraps the signup endpoint, the auth handler self-gates
  // its own routes, browser routes get redirect semantics, and the API gate
  // remains the secure default for everything else. Lazy getAuth(): an
  // auth-disabled app never constructs the instance or touches SQLite.
  if (authEnabled) {
    const claimGuard = options.claimGuard ?? createClaimGuard();
    const authHandler =
      options.authHandler ?? ((request) => getAuth().handler(request));
    app.use(SIGNUP_PATH, claimGuard);
    app.use(SIGNIN_PATH, claimGuard);
    app.use("/api/auth/organization/*", async (c, next) => {
      if (
        c.req.method === "POST" &&
        CONTROLLED_ORGANIZATION_MUTATIONS.has(c.req.path)
      ) {
        return c.json({ error: { message: "Forbidden" } }, 403);
      }
      return next();
    });
    app.on(["POST", "GET"], "/api/auth/*", (c) => authHandler(c.req.raw));
    app.get("/", createRootRedirect(options.sessionLookup));
    app.use(
      "/app/*",
      createWebAccessGate(
        options.sessionLookup,
        options.orgLister,
        membershipLookup,
      ),
    );
    app.use(
      "/app/*",
      createOrganizationRoleEnrichment(options.activeMemberLookup),
    );
    const organizationAdminGate = createOrganizationAdminGate(
      options.sessionLookup,
      options.activeMemberLookup,
    );
    app.use("/admin", organizationAdminGate);
    app.use("/admin/*", organizationAdminGate);
    app.use(
      "*",
      createIdentityGate(
        options.sessionLookup,
        options.orgLister,
        (path) => isOperatorPath(path) || isPublicWebPath(path),
        membershipLookup,
      ),
    );
    log.info("better-auth identity gate active");
  } else {
    app.get("/", (c) => c.redirect("/app"));
    log.warn(
      "AUTH_ENABLED=false — API is UNAUTHENTICATED; enable auth before exposing this server publicly",
    );
  }

  type HealthStatus = { status: string; latency?: string; error?: string };

  app.get("/health", (c) => {
    const start = Date.now();
    const [err] = attemptSync(() => getTenantDb().query("SELECT 1").get());
    const store: HealthStatus = err
      ? { status: "down", error: err.message }
      : { status: "ok", latency: `${Date.now() - start}ms` };
    const status = err ? "degraded" : "ok";
    return c.json(
      { status, version: "0.3.0", services: { tenantStore: store } },
      err ? 503 : 200,
    );
  });

  app.route("/v1/system-prompt", systemPrompt);
  app.route("/v1/keys", options.keyRoutes ?? keys);
  app.route("/v1/members", options.memberRoutes ?? members);
  app.route("/v1/sync", sync);
  app.route("/mcp", mcp);
  app.route(
    "/",
    createWeb({
      organizationAdmin: authEnabled,
      ...(authEnabled ? { organizationAuditList } : {}),
      ...(authEnabled ? { organizationMembers } : {}),
      ...(authEnabled
        ? {
            authForms: {
              origin: new URL(config.auth.baseUrl).origin,
              request: (path: string, init: RequestInit) =>
                app.request(path, init),
            },
            credentials: {
              origin: new URL(config.auth.baseUrl).origin,
              request: (path: string, init: RequestInit) =>
                app.request(path, init),
            },
          }
        : {}),
    }),
  );

  return app;
}
