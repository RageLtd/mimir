import type { Context } from "hono";
import type {
  CancelOrganizationDeletionInput,
  readOrganizationLifecycle,
  ScheduleOrganizationDeletionInput,
} from "../auth/organization-lifecycle";
import type {
  readOrganizationSettings,
  UpdateOrganizationNameInput,
  UpdateOrganizationPolicyInput,
  UpdateOrganizationSlugInput,
} from "../auth/organization-settings";
import {
  MAX_AUDIT_RETENTION_DAYS,
  MAX_INVITATION_LIFETIME_DAYS,
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_ORGANIZATION_SLUG_LENGTH,
  MIN_AUDIT_RETENTION_DAYS,
  MIN_INVITATION_LIFETIME_DAYS,
  MIN_ORGANIZATION_SLUG_LENGTH,
} from "../auth/organization-settings-schema";
import type { IdentityEnv } from "../middleware/identity";
import { attemptSync } from "../util/result";
import { DashboardNavigation, PageFrame } from "./chrome";

export interface OrganizationSettingsOptions {
  origin: string;
  read: (orgId: string) => ReturnType<typeof readOrganizationSettings>;
  updateName: (
    input: UpdateOrganizationNameInput,
    headers: Headers,
  ) => Promise<string>;
  updateSlug: (
    input: UpdateOrganizationSlugInput,
    headers: Headers,
  ) => Promise<string>;
  updatePolicy: (input: UpdateOrganizationPolicyInput) => string;
  readLifecycle: (
    orgId: string,
  ) => ReturnType<typeof readOrganizationLifecycle>;
  scheduleDeletion: (input: ScheduleOrganizationDeletionInput) => string;
  cancelDeletion: (input: CancelOrganizationDeletionInput) => string;
  now?: () => number;
}

interface SettingsPageState {
  error?: boolean;
}

function noticeText(value: string | undefined) {
  if (value === "name") return "Organization name updated.";
  if (value === "slug") return "Organization slug updated.";
  if (value === "policy") return "Organization policy updated.";
  if (value === "deletion-scheduled") {
    return "Organization deletion scheduled. It may be cancelled until the purge begins.";
  }
  if (value === "deletion-cancelled") {
    return "Organization deletion cancelled.";
  }
  return "";
}

function readableTime(value: string) {
  return value.replace("T", " ").replace(".000Z", " UTC");
}

export function renderOrganizationSettings(
  c: Context<IdentityEnv>,
  options: OrganizationSettingsOptions,
  state: SettingsPageState = {},
) {
  const identity = c.get("identity");
  if (!identity) return c.text("Forbidden", 403);
  const [error, settings] = attemptSync(() => options.read(identity.orgId));
  if (error || !settings) return c.text("Unavailable", 503);
  const owner = identity.organizationRoles?.includes("owner") ?? false;
  const lifecycleResult = owner
    ? attemptSync(() => options.readLifecycle(identity.orgId))
    : null;
  if (
    owner &&
    (!lifecycleResult || lifecycleResult[0] || !lifecycleResult[1])
  ) {
    return c.text("Unavailable", 503);
  }
  const lifecycle = lifecycleResult?.[1];
  const notice = noticeText(c.req.query("notice"));
  c.header("cache-control", "private, no-store");
  c.status(state.error ? 400 : 200);
  return c.render(
    <PageFrame
      actions={<a href="/admin">Organization</a>}
      navigation={
        <DashboardNavigation current="admin" organizationAdmin={true} />
      }
    >
      <section
        aria-labelledby="settings-title"
        data-user-id={identity.userId}
        data-organization-id={identity.orgId}
      >
        <p class="kicker">Organization administration</p>
        <h1 id="settings-title">Settings &amp; policy</h1>
        <p class="lede">
          Configure this organization without crossing into server operation or
          encrypted tenant content.
        </p>
        {notice ? (
          <p class="notice" role="status">
            {notice}
          </p>
        ) : null}
        {state.error ? (
          <p class="form-error" role="alert">
            The organization change could not be completed.
          </p>
        ) : null}

        <div class="cards">
          <section class="card" aria-labelledby="identity-settings-title">
            <h2 id="identity-settings-title">Organization identity</h2>
            <form class="stack" method="post" action="/admin/settings/name">
              <input type="hidden" name="expectedName" value={settings.name} />
              <label for="organization-name">Display name</label>
              <input
                id="organization-name"
                name="name"
                value={settings.name}
                maxlength={MAX_ORGANIZATION_NAME_LENGTH}
                required
              />
              <button class="button" type="submit">
                Update name
              </button>
            </form>
            <dl class="status">
              <dt>Organization ID</dt>
              <dd class="secret">{settings.id}</dd>
            </dl>
          </section>

          <section class="card" aria-labelledby="security-status-title">
            <h2 id="security-status-title">Encryption status</h2>
            <p>
              Key rotation and recovery remain client-side cryptographic
              ceremonies. These values are status only.
            </p>
            <dl class="status">
              <dt>Key generation</dt>
              <dd>{settings.keyGeneration ?? "Not initialized"}</dd>
              <dt>Recovery</dt>
              <dd>
                {settings.recoveryReady
                  ? "Recovery configured"
                  : "Recovery not configured"}
              </dd>
            </dl>
          </section>

          {owner ? (
            <section class="card" aria-labelledby="slug-settings-title">
              <h2 id="slug-settings-title">Organization slug</h2>
              <p>
                Slug changes affect organization links and require recent
                authentication.
              </p>
              <form class="stack" method="post" action="/admin/settings/slug">
                <input
                  type="hidden"
                  name="expectedSlug"
                  value={settings.slug}
                />
                <label for="organization-slug">Slug</label>
                <input
                  id="organization-slug"
                  name="slug"
                  value={settings.slug}
                  minlength={MIN_ORGANIZATION_SLUG_LENGTH}
                  maxlength={MAX_ORGANIZATION_SLUG_LENGTH}
                  pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                  required
                />
                <button class="button" type="submit">
                  Update slug
                </button>
              </form>
            </section>
          ) : null}

          {owner ? (
            <section class="card" aria-labelledby="policy-settings-title">
              <h2 id="policy-settings-title">Access &amp; audit policy</h2>
              <p>
                Policy changes require recent authentication and are recorded in
                organization activity.
              </p>
              <form class="stack" method="post" action="/admin/settings/policy">
                <input
                  type="hidden"
                  name="expectedVersion"
                  value={settings.policyVersion}
                />
                <label for="default-invitation-role">
                  Default invitation role
                </label>
                <select
                  id="default-invitation-role"
                  name="defaultInvitationRole"
                >
                  <option
                    value="member"
                    selected={settings.defaultInvitationRole === "member"}
                  >
                    member
                  </option>
                  <option
                    value="admin"
                    selected={settings.defaultInvitationRole === "admin"}
                  >
                    admin
                  </option>
                </select>
                <label for="invitation-lifetime">
                  Invitation lifetime in days
                </label>
                <input
                  id="invitation-lifetime"
                  name="invitationLifetimeDays"
                  type="number"
                  value={settings.invitationLifetimeDays}
                  min={MIN_INVITATION_LIFETIME_DAYS}
                  max={MAX_INVITATION_LIFETIME_DAYS}
                  required
                />
                <label for="audit-retention">Audit retention in days</label>
                <input
                  id="audit-retention"
                  name="auditRetentionDays"
                  type="number"
                  value={settings.auditRetentionDays}
                  min={MIN_AUDIT_RETENTION_DAYS}
                  max={MAX_AUDIT_RETENTION_DAYS}
                  required
                />
                <button class="button" type="submit">
                  Update policy
                </button>
              </form>
            </section>
          ) : null}

          {owner && lifecycle ? (
            <section class="card" aria-labelledby="lifecycle-settings-title">
              <h2 id="lifecycle-settings-title">Ownership &amp; deletion</h2>
              <p>
                This organization has {lifecycle.ownerCount} owner
                {lifecycle.ownerCount === 1 ? "" : "s"}, of whom{" "}
                {lifecycle.keyedOwnerCount} currently hold encrypted key access.
                Promote another key-ready member before leaving.
              </p>
              <p>
                <a href="/admin/members">Manage owners and members</a>
              </p>
              {lifecycle.deletion ? (
                <div class="stack">
                  <p role="status">
                    Deletion was scheduled at{" "}
                    <time datetime={lifecycle.deletion.scheduledAt}>
                      {readableTime(lifecycle.deletion.scheduledAt)}
                    </time>
                    . Purging begins after{" "}
                    <time datetime={lifecycle.deletion.purgeAfter}>
                      {readableTime(lifecycle.deletion.purgeAfter)}
                    </time>
                    .
                  </p>
                  {lifecycle.deletion.status === "scheduled" ? (
                    <form
                      class="stack"
                      method="post"
                      action="/admin/settings/deletion/cancel"
                    >
                      <input
                        type="hidden"
                        name="scheduleId"
                        value={lifecycle.deletion.scheduleId}
                      />
                      <button class="button" type="submit">
                        Cancel organization deletion
                      </button>
                    </form>
                  ) : (
                    <p>Purging has begun and can no longer be cancelled.</p>
                  )}
                </div>
              ) : (
                <div class="stack">
                  <p>
                    Deletion permanently removes memberships, invitations,
                    wrapped key shelves, recovery configuration, encrypted
                    server records, synchronization state, and organization
                    activity after a seven-day grace period. Recovery keys
                    cannot restore ciphertext after the server purge.
                  </p>
                  <p>
                    <a href="/admin/memories">Export an encrypted backup</a>
                    {" before scheduling deletion."}
                  </p>
                  <form
                    class="stack"
                    method="post"
                    action="/admin/settings/deletion/schedule"
                  >
                    <label for="organization-deletion-confirmation">
                      Type <strong>{settings.name}</strong> to confirm
                    </label>
                    <input
                      id="organization-deletion-confirmation"
                      name="confirmation"
                      autocomplete="off"
                      required
                    />
                    <button class="button" type="submit">
                      Schedule organization deletion
                    </button>
                  </form>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </section>
    </PageFrame>,
    {
      title: "Organization settings — Mimir",
      description: "Manage bounded settings for the active organization.",
      styles: ["dashboard", "card", "cards", "forms", "status", "secret"],
    },
  );
}
