import { Hono } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { canManageOrganization } from "../middleware/organization-roles";
import {
  type OrganizationAuditList,
  renderOrganizationActivity,
} from "./activity";
import { renderOrganizationAdmin } from "./admin";
import {
  type AuthFormOptions,
  createSignInAction,
  createSignUpAction,
  renderSignIn,
  renderSignUp,
} from "./auth-forms";
import { DashboardNavigation, PageFrame, pageRenderer } from "./chrome";
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
  type OrganizationSettingsOptions,
  renderOrganizationSettings,
} from "./settings";
import {
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
  organizationSettings?: OrganizationSettingsOptions;
}

export function createWeb(options: WebOptions = {}) {
  const web = new Hono<IdentityEnv>();
  web.use("*", webCompression);
  web.use("*", pageRenderer);

  web.get("/sign-in", (c) => renderSignIn(c));
  web.get("/sign-up", (c) => renderSignUp(c));
  web.get("/assets/credentials.js", credentialIslandResponse);
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

  web.get("/app/memories", (c) => renderMemories(c));
  if (options.organizationAdmin) {
    web.get("/admin", (c) => renderOrganizationAdmin(c));
    const organizationAuditList = options.organizationAuditList;
    if (organizationAuditList) {
      web.get("/admin/activity", (c) =>
        renderOrganizationActivity(c, organizationAuditList),
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
    }
  }

  web.get("/app", (c) => {
    const identity = c.get("identity");
    return c.render(
      <PageFrame
        actions={<a href="/">Home</a>}
        navigation={
          <DashboardNavigation
            current="overview"
            organizationAdmin={canManageOrganization(identity)}
          />
        }
      >
        <section
          aria-labelledby="dashboard-title"
          data-user-id={identity?.userId}
          data-organization-id={identity?.orgId}
        >
          <p class="kicker">Workspace</p>
          <h1 id="dashboard-title">Dashboard</h1>
          <p class="lede">
            Your account, devices, and shared context will live here.
          </p>
          <div class="cards">
            <section class="card" aria-labelledby="account-card-title">
              <h2 id="account-card-title">Account</h2>
              <p>Manage your identity and active organization.</p>
            </section>
            <section class="card" aria-labelledby="memory-card-title">
              <h2 id="memory-card-title">Memory</h2>
              <p>Review the encrypted context available to your agents.</p>
            </section>
          </div>
        </section>
      </PageFrame>,
      {
        title: "Dashboard — Mimir",
        description: "Manage your Mimir account, devices, and agent context.",
      },
    );
  });

  return web;
}

export const web = createWeb();
