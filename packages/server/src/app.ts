import { Hono } from "hono";
import { cors } from "hono/cors";
import { createOrganizationAuditStore } from "./audit/store";
import { createClaimGuard } from "./auth/claim";
import { getAuth, getAuthDb } from "./auth/instance";
import {
  cancelOrganizationDeletion,
  readOrganizationLifecycle,
  scheduleOrganizationDeletion,
} from "./auth/organization-lifecycle";
import {
  createOrganizationInvitation,
  listOrganizationMembers,
  reissueOrganizationInvitation,
  revokeOrganizationInvitation,
} from "./auth/organization-members";
import {
  readOrganizationSettings,
  updateOrganizationName,
  updateOrganizationPolicy,
  updateOrganizationSlug,
} from "./auth/organization-settings";
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
import {
  createOperatorGate,
  isOperatorMcpPath,
  type OperatorCredentialDigestLookup,
} from "./middleware/operator";
import {
  createOperatorBrowserGate,
  createOperatorNavigationEnrichment,
  isOperatorBrowserPath,
  type OperatorGrantLookup,
} from "./middleware/operator-browser";
import {
  type ActiveMemberLookup,
  createOrganizationAdminGate,
  createOrganizationRoleEnrichment,
} from "./middleware/organization-admin";
import {
  createRootRedirect,
  createWebAccessGate,
} from "./middleware/web-access";
import { OPERATOR_PATH_GLOB, OPERATOR_ROOT_PATH } from "./operator/paths";
import {
  grantOperator,
  listOperatorAudit,
  listOperatorGrants,
  provisionOrganization,
  readInstanceSettings,
  readOperatorCredentialDigest,
  replaceOperatorCredential,
  revokeOperator,
  updateInstanceSetting,
} from "./operator/state";
import { type createKeysRoutes, keys } from "./routes/keys";
import { mcp } from "./routes/mcp";
import { type createMembersRoutes, members } from "./routes/members";
import { sync } from "./routes/sync";
import {
  createSystemPromptRoutes,
  type SystemPromptReader,
} from "./routes/system-prompt";
import { log } from "./util/logger";
import { attemptSync } from "./util/result";
import { createWeb } from "./web";
import type { OrganizationAuditList } from "./web/activity";
import type { OrganizationMembersOptions } from "./web/members";
import type { OrganizationMemoryMaintenanceOptions } from "./web/memory-maintenance";
import type { OperatorDashboardOptions } from "./web/operator";
import { isPublicWebPath } from "./web/paths";
import type { OrganizationSettingsOptions } from "./web/settings";

const CONTROLLED_ORGANIZATION_MUTATIONS = new Set([
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/leave",
  "/api/auth/organization/delete",
  "/api/auth/organization/update",
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
  organizationMemoryMaintenance?: OrganizationMemoryMaintenanceOptions;
  organizationSettings?: OrganizationSettingsOptions;
  keyRoutes?: ReturnType<typeof createKeysRoutes>;
  memberRoutes?: ReturnType<typeof createMembersRoutes>;
  operatorToken?: string;
  operatorCredentialDigestLookup?: OperatorCredentialDigestLookup;
  operatorGrantLookup?: OperatorGrantLookup;
  operatorDashboard?: OperatorDashboardOptions;
  systemPromptReader?: SystemPromptReader;
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
  const organizationSettings: OrganizationSettingsOptions =
    options.organizationSettings ?? {
      origin: new URL(config.auth.baseUrl).origin,
      read: (orgId) => readOrganizationSettings(getAuthDb(), orgId),
      updateName: (input, headers) =>
        updateOrganizationName(
          getAuthDb(),
          (body, forwarded) =>
            getAuth().api.updateOrganization({ body, headers: forwarded }),
          input,
          headers,
        ),
      updateSlug: (input, headers) =>
        updateOrganizationSlug(
          getAuthDb(),
          (body, forwarded) =>
            getAuth().api.updateOrganization({ body, headers: forwarded }),
          input,
          headers,
        ),
      updatePolicy: (input) => updateOrganizationPolicy(getAuthDb(), input),
      readLifecycle: (orgId) => readOrganizationLifecycle(getAuthDb(), orgId),
      scheduleDeletion: (input) =>
        scheduleOrganizationDeletion(getAuthDb(), input),
      cancelDeletion: (input) => cancelOrganizationDeletion(getAuthDb(), input),
    };
  const organizationMemoryMaintenance: OrganizationMemoryMaintenanceOptions =
    options.organizationMemoryMaintenance ?? {
      origin: new URL(config.auth.baseUrl).origin,
      push: async (envelopes, headers) =>
        app.request("/v1/sync/push", {
          method: "POST",
          headers,
          body: JSON.stringify({ envelopes }),
        }),
      audit: (event) => {
        auditStore ??= createOrganizationAuditStore(getAuthDb());
        return auditStore.append(event);
      },
    };

  const operatorDashboard: OperatorDashboardOptions | undefined = authEnabled
    ? (options.operatorDashboard ?? {
        origin: new URL(config.auth.baseUrl).origin,
        readSettings: () => readInstanceSettings(getAuthDb()),
        listGrants: () => listOperatorGrants(getAuthDb()),
        listAudit: () => listOperatorAudit(getAuthDb()),
        readHealth: () => {
          const [tenantError] = attemptSync(() =>
            getTenantDb().query("SELECT 1").get(),
          );
          const userCount = getAuthDb()
            .query<{ count: number }, []>(
              'SELECT count(*) AS count FROM "user"',
            )
            .get()?.count;
          const organizationCount = getAuthDb()
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM organization",
            )
            .get()?.count;
          const operatorCount = getAuthDb()
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM instance_operator_grant",
            )
            .get()?.count;
          return {
            version: "0.3.0",
            tenantStore: tenantError ? "down" : "ok",
            userCount: userCount ?? 0,
            organizationCount: organizationCount ?? 0,
            operatorCount: operatorCount ?? 0,
          };
        },
        updateSetting: (input) => updateInstanceSetting(getAuthDb(), input),
        replaceCredential: (input) =>
          replaceOperatorCredential(getAuthDb(), input),
        grant: (input) => grantOperator(getAuthDb(), input),
        revoke: (input) => revokeOperator(getAuthDb(), input),
        provision: (input) => provisionOrganization(getAuthDb(), input),
      })
    : undefined;

  app.use("*", cors());
  app.use(
    "*",
    createOperatorGate(
      options.operatorToken,
      options.operatorCredentialDigestLookup ??
        (authEnabled
          ? () => readOperatorCredentialDigest(getAuthDb())
          : undefined),
    ),
  );

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
    const organizationRoleEnrichment = createOrganizationRoleEnrichment(
      options.activeMemberLookup,
      options.sessionLookup,
    );
    app.use("/app/*", organizationRoleEnrichment);
    const operatorNavigationEnrichment = createOperatorNavigationEnrichment(
      options.operatorGrantLookup,
    );
    app.use("/app/*", operatorNavigationEnrichment);
    const organizationAdminGate = createOrganizationAdminGate(
      options.sessionLookup,
      options.activeMemberLookup,
    );
    app.use("/admin", organizationAdminGate);
    app.use("/admin/*", organizationAdminGate);
    app.use("/admin", operatorNavigationEnrichment);
    app.use("/admin/*", operatorNavigationEnrichment);
    const operatorBrowserGate = createOperatorBrowserGate(
      options.sessionLookup,
      options.operatorGrantLookup,
    );
    app.use(OPERATOR_ROOT_PATH, operatorBrowserGate);
    app.use(OPERATOR_PATH_GLOB, operatorBrowserGate);
    app.use(OPERATOR_ROOT_PATH, organizationRoleEnrichment);
    app.use(OPERATOR_PATH_GLOB, organizationRoleEnrichment);
    app.use(
      "*",
      createIdentityGate(
        options.sessionLookup,
        options.orgLister,
        (path) =>
          isOperatorMcpPath(path) ||
          isOperatorBrowserPath(path) ||
          isPublicWebPath(path),
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

  app.route(
    "/v1/system-prompt",
    createSystemPromptRoutes(
      options.systemPromptReader ??
        (authEnabled
          ? () => readInstanceSettings(getAuthDb()).systemPrompt
          : undefined),
    ),
  );
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
      ...(authEnabled ? { organizationMemoryMaintenance } : {}),
      ...(authEnabled ? { organizationSettings } : {}),
      ...(operatorDashboard ? { operator: operatorDashboard } : {}),
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
