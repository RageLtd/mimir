import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { isTrustedRecentBrowser } from "../middleware/recent-browser";
import { attempt, attemptSync } from "../util/result";
import { formValue, hasTrustedOrigin, readForm } from "./forms";
import {
  type OrganizationSettingsOptions,
  renderOrganizationSettings,
} from "./settings";

const SETTINGS_PATH = "/admin/settings";
const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const INTEGER = /^\d+$/;

function requestId(c: Context<IdentityEnv>) {
  const value = c.req.header("x-request-id");
  return value && OPAQUE_ID.test(value) ? value : crypto.randomUUID();
}

function forwardedHeaders(c: Context<IdentityEnv>) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  return headers;
}

function redirect(notice: string) {
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "private, no-store",
      location: `${SETTINGS_PATH}?${new URLSearchParams({ notice })}`,
    },
  });
}

function parsedInteger(value: string) {
  if (!INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function owner(c: Context<IdentityEnv>) {
  return c.get("identity")?.organizationRoles?.includes("owner") ?? false;
}

const failed = (
  c: Context<IdentityEnv>,
  options: OrganizationSettingsOptions,
) => renderOrganizationSettings(c, options, { error: true });

export const createOrganizationNameAction =
  (options: OrganizationSettingsOptions) => async (c: Context<IdentityEnv>) => {
    const identity = c.get("identity");
    const form = await readForm(c);
    if (!identity || !form || !hasTrustedOrigin(c, options)) {
      return failed(c, options);
    }
    const [error, result] = await attempt(() =>
      options.updateName(
        {
          orgId: identity.orgId,
          actorUserId: identity.userId,
          requestId: requestId(c),
          expectedName: formValue(form, "expectedName"),
          name: formValue(form, "name"),
        },
        forwardedHeaders(c),
      ),
    );
    return !error && (result === "updated" || result === "unchanged")
      ? redirect("name")
      : failed(c, options);
  };

export const createOrganizationSlugAction =
  (options: OrganizationSettingsOptions) => async (c: Context<IdentityEnv>) => {
    const identity = c.get("identity");
    const form = await readForm(c);
    if (!identity || !owner(c) || !form || !hasTrustedOrigin(c, options)) {
      return failed(c, options);
    }
    const [error, result] = await attempt(() =>
      options.updateSlug(
        {
          orgId: identity.orgId,
          actorUserId: identity.userId,
          requestId: requestId(c),
          expectedSlug: formValue(form, "expectedSlug"),
          slug: formValue(form, "slug"),
          recentAuthentication: isTrustedRecentBrowser(
            c,
            options.origin,
            options.now ?? Date.now,
          ),
        },
        forwardedHeaders(c),
      ),
    );
    return !error && (result === "updated" || result === "unchanged")
      ? redirect("slug")
      : failed(c, options);
  };

export const createOrganizationPolicyAction =
  (options: OrganizationSettingsOptions) => async (c: Context<IdentityEnv>) => {
    const identity = c.get("identity");
    const form = await readForm(c);
    const expectedVersion = form
      ? parsedInteger(formValue(form, "expectedVersion"))
      : null;
    const invitationLifetimeDays = form
      ? parsedInteger(formValue(form, "invitationLifetimeDays"))
      : null;
    const auditRetentionDays = form
      ? parsedInteger(formValue(form, "auditRetentionDays"))
      : null;
    if (
      !identity ||
      !owner(c) ||
      !form ||
      !hasTrustedOrigin(c, options) ||
      expectedVersion === null ||
      invitationLifetimeDays === null ||
      auditRetentionDays === null
    ) {
      return failed(c, options);
    }
    const [error, result] = attemptSync(() =>
      options.updatePolicy({
        orgId: identity.orgId,
        actorUserId: identity.userId,
        requestId: requestId(c),
        expectedVersion,
        defaultInvitationRole: formValue(form, "defaultInvitationRole"),
        invitationLifetimeDays,
        auditRetentionDays,
        recentAuthentication: isTrustedRecentBrowser(
          c,
          options.origin,
          options.now ?? Date.now,
        ),
      }),
    );
    return !error && (result === "updated" || result === "unchanged")
      ? redirect("policy")
      : failed(c, options);
  };
