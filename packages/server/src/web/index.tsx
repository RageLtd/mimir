import { Hono } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import {
  OPERATOR_AUDIT_PATH,
  OPERATOR_GRANT_PATH,
  OPERATOR_GRANTS_PATH,
  OPERATOR_HEALTH_PATH,
  OPERATOR_ORGANIZATIONS_PATH,
  OPERATOR_ORGANIZATIONS_PROVISION_PATH,
  OPERATOR_REVOKE_PATH,
  OPERATOR_ROOT_PATH,
  OPERATOR_SETTINGS_MCP_CREDENTIAL_PATH,
  OPERATOR_SETTINGS_NAME_PATH,
  OPERATOR_SETTINGS_PATH,
  OPERATOR_SETTINGS_SUPPORT_URL_PATH,
  OPERATOR_SETTINGS_SYSTEM_PROMPT_PATH,
} from "../operator/paths";
import {
  type OrganizationAuditList,
  renderOrganizationActivity,
} from "./activity";
import { renderOrganizationAdmin, renderOrganizationBilling } from "./admin";
import { renderAdminMemories } from "./admin-memories";
import {
  type AuthFormOptions,
  createSignInAction,
  createSignUpAction,
  renderSignIn,
  renderSignUp,
} from "./auth-forms";
import { dashboardNavigation, PageFrame, pageRenderer } from "./chrome";
import { webCompression } from "./compression";
import {
  createApiKeyAction,
  createPasswordAction,
  createRenamePasskeyAction,
  createRevokeApiKeyAction,
  createRevokeOtherSessionsAction,
  createRevokePasskeyAction,
  createRevokeSessionAction,
} from "./credential-actions";
import { type CredentialOptions, renderCredentials } from "./credentials";
import {
  adminMemoryIslandResponse,
  credentialIslandResponse,
  memberIslandResponse,
  memoryIslandResponse,
} from "./islands";
import {
  createChangeMemberRoleAction,
  createInviteMemberAction,
  createReissueInvitationAction,
  createRevokeInvitationAction,
} from "./member-actions";
import {
  type OrganizationMembersOptions,
  renderOrganizationMembers,
} from "./members";
import { renderMemories } from "./memories";
import {
  createMemoryMaintenanceAction,
  type OrganizationMemoryMaintenanceOptions,
} from "./memory-maintenance";
import {
  type OperatorDashboardOptions,
  renderOperatorAudit,
  renderOperatorGrants,
  renderOperatorHealth,
  renderOperatorHome,
  renderOperatorOrganizations,
  renderOperatorSettings,
} from "./operator";
import {
  createGrantOperatorAction,
  createInstanceSettingAction,
  createOperatorCredentialAction,
  createProvisionOrganizationAction,
  createRevokeOperatorAction,
} from "./operator-actions";
import {
  type OrganizationSettingsOptions,
  renderOrganizationSettings,
} from "./settings";
import {
  createOrganizationDeletionCancelAction,
  createOrganizationDeletionScheduleAction,
  createOrganizationNameAction,
  createOrganizationPolicyAction,
  createOrganizationSlugAction,
} from "./settings-actions";

interface WebOptions {
  authForms?: AuthFormOptions;
  credentials?: CredentialOptions;
  organizationAdmin?: boolean;
  organizationAuditList?: OrganizationAuditList;
  organizationMembers?: OrganizationMembersOptions;
  organizationMemoryMaintenance?: OrganizationMemoryMaintenanceOptions;
  organizationSettings?: OrganizationSettingsOptions;
  operator?: OperatorDashboardOptions;
}

export function createWeb(options: WebOptions = {}) {
  const web = new Hono<IdentityEnv>();
  web.use("*", webCompression);
  web.use("*", pageRenderer);

  web.get("/sign-in", (c) => renderSignIn(c));
  web.get("/sign-up", (c) => renderSignUp(c));
  web.get("/assets/credentials.js", credentialIslandResponse);
  web.get("/assets/admin-memories.js", adminMemoryIslandResponse);
  web.get("/assets/memories.js", memoryIslandResponse);
  web.get("/assets/members.js", memberIslandResponse);
  if (options.authForms) {
    web.post("/sign-in", createSignInAction(options.authForms));
    web.post("/sign-up", createSignUpAction(options.authForms));
  }
  if (options.credentials) {
    const credentials = options.credentials;
    web.get("/app/credentials", (c) => renderCredentials(c, credentials));
    web.post("/app/credentials/password", createPasswordAction(credentials));
    web.post("/app/credentials/api-keys", createApiKeyAction(credentials));
    web.post(
      "/app/credentials/api-keys/revoke",
      createRevokeApiKeyAction(credentials),
    );
    web.post(
      "/app/credentials/sessions/revoke",
      createRevokeSessionAction(credentials),
    );
    web.post(
      "/app/credentials/sessions/revoke-others",
      createRevokeOtherSessionsAction(credentials),
    );
    web.post(
      "/app/credentials/passkeys/revoke",
      createRevokePasskeyAction(credentials),
    );
    web.post(
      "/app/credentials/passkeys/rename",
      createRenamePasskeyAction(credentials),
    );
  }

  const operator = options.operator;
  if (operator) {
    web.get(OPERATOR_ROOT_PATH, renderOperatorHome);
    web.get(OPERATOR_SETTINGS_PATH, (c) => renderOperatorSettings(c, operator));
    web.post(
      OPERATOR_SETTINGS_NAME_PATH,
      createInstanceSettingAction(operator, "instance_name"),
    );
    web.post(
      OPERATOR_SETTINGS_SUPPORT_URL_PATH,
      createInstanceSettingAction(operator, "support_url"),
    );
    web.post(
      OPERATOR_SETTINGS_SYSTEM_PROMPT_PATH,
      createInstanceSettingAction(operator, "system_prompt"),
    );
    web.post(
      OPERATOR_SETTINGS_MCP_CREDENTIAL_PATH,
      createOperatorCredentialAction(operator),
    );
    web.get(OPERATOR_ORGANIZATIONS_PATH, (c) => renderOperatorOrganizations(c));
    web.post(
      OPERATOR_ORGANIZATIONS_PROVISION_PATH,
      createProvisionOrganizationAction(operator),
    );
    web.get(OPERATOR_GRANTS_PATH, (c) => renderOperatorGrants(c, operator));
    web.post(OPERATOR_GRANT_PATH, createGrantOperatorAction(operator));
    web.post(OPERATOR_REVOKE_PATH, createRevokeOperatorAction(operator));
    web.get(OPERATOR_HEALTH_PATH, (c) => renderOperatorHealth(c, operator));
    web.get(OPERATOR_AUDIT_PATH, (c) => renderOperatorAudit(c, operator));
  }

  web.get("/app/memories", (c) => renderMemories(c));
  if (options.organizationAdmin) {
    web.get("/admin", (c) => renderOrganizationAdmin(c));
    web.get("/admin/billing", (c) => renderOrganizationBilling(c));
    const organizationAuditList = options.organizationAuditList;
    if (organizationAuditList) {
      web.get("/admin/activity", (c) =>
        renderOrganizationActivity(c, organizationAuditList),
      );
    }
    const organizationMemoryMaintenance = options.organizationMemoryMaintenance;
    if (organizationMemoryMaintenance) {
      web.get("/admin/memories", (c) => renderAdminMemories(c));
      web.post(
        "/admin/memories/maintenance",
        createMemoryMaintenanceAction(organizationMemoryMaintenance),
      );
    }
    const organizationMembers = options.organizationMembers;
    if (organizationMembers) {
      web.get("/admin/members", (c) =>
        renderOrganizationMembers(c, organizationMembers),
      );
      web.post(
        "/admin/members/invite",
        createInviteMemberAction(organizationMembers),
      );
      web.post(
        "/admin/members/invitations/revoke",
        createRevokeInvitationAction(organizationMembers),
      );
      web.post(
        "/admin/members/invitations/reissue",
        createReissueInvitationAction(organizationMembers),
      );
      web.post(
        "/admin/members/role",
        createChangeMemberRoleAction(organizationMembers),
      );
    }
    const organizationSettings = options.organizationSettings;
    if (organizationSettings) {
      web.get("/admin/settings", (c) =>
        renderOrganizationSettings(c, organizationSettings),
      );
      web.post(
        "/admin/settings/name",
        createOrganizationNameAction(organizationSettings),
      );
      web.post(
        "/admin/settings/slug",
        createOrganizationSlugAction(organizationSettings),
      );
      web.post(
        "/admin/settings/policy",
        createOrganizationPolicyAction(organizationSettings),
      );
      web.post(
        "/admin/settings/deletion/schedule",
        createOrganizationDeletionScheduleAction(organizationSettings),
      );
      web.post(
        "/admin/settings/deletion/cancel",
        createOrganizationDeletionCancelAction(organizationSettings),
      );
    }
  }

  web.get("/app", (c) => {
    const identity = c.get("identity");
    return c.render(
      <PageFrame
        actions={<a href="/">Home</a>}
        navigation={dashboardNavigation(c, "account")}
      >
        <section
          aria-labelledby="dashboard-title"
          data-user-id={identity?.userId}
          data-organization-id={identity?.orgId}
        >
          <p class="kicker">Your Mimir account</p>
          <h1 id="dashboard-title">Account</h1>
          <p class="lede">
            Manage the identity signed into this browser and its active
            organization.
          </p>
          <dl class="status">
            <dt>User</dt>
            <dd class="secret">{identity?.userId ?? "Local user"}</dd>
            <dt>Active organization</dt>
            <dd class="secret">{identity?.orgId ?? "Local organization"}</dd>
          </dl>
        </section>
      </PageFrame>,
      {
        title: "Account — Mimir",
        description: "Manage your Mimir account and active organization.",
        styles: ["dashboard", "status", "secret"],
      },
    );
  });

  return web;
}

export const web = createWeb();
