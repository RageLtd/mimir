import type { Context } from "hono";
import type {
  CreateInvitationInput,
  InvitationMutationInput,
} from "../auth/organization-members";
import type { IdentityEnv, ResolvedIdentity } from "../middleware/identity";
import { isTrustedRecentBrowser } from "../middleware/recent-browser";
import { formValue, hasTrustedOrigin, readForm } from "./forms";
import {
  type OrganizationMembersOptions,
  renderOrganizationMembers,
} from "./members";

const MEMBERS_PATH = "/admin/members";
const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;

function role(value: string) {
  return value === "owner" || value === "admin" || value === "member"
    ? value
    : null;
}

function actorRole(identity: ResolvedIdentity) {
  return identity.organizationRoles?.includes("owner") ? "owner" : "admin";
}

function requestId(c: Context<IdentityEnv>) {
  const value = c.req.header("x-request-id");
  return value && OPAQUE_ID.test(value) ? value : crypto.randomUUID();
}

function forwardedHeaders(c: Context<IdentityEnv>, contentType?: string) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

function redirect(notice: string) {
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "private, no-store",
      location: `${MEMBERS_PATH}?${new URLSearchParams({ notice })}`,
    },
  });
}

async function invitationInput(
  c: Context<IdentityEnv>,
  options: OrganizationMembersOptions,
) {
  const identity = c.get("identity");
  const form = await readForm(c);
  if (!identity || !form || !hasTrustedOrigin(c, options)) return null;
  const email = formValue(form, "email").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > MAX_EMAIL_LENGTH) return null;
  return {
    form,
    input: {
      orgId: identity.orgId,
      actorUserId: identity.userId,
      actorRole: actorRole(identity),
      email,
      requestId: requestId(c),
      recentAuthentication: isTrustedRecentBrowser(
        c,
        options.origin,
        options.now ?? Date.now,
      ),
    } satisfies InvitationMutationInput,
    headers: forwardedHeaders(c),
  };
}

const failed = (c: Context<IdentityEnv>, options: OrganizationMembersOptions) =>
  renderOrganizationMembers(c, options, { error: true });

export const createInviteMemberAction =
  (options: OrganizationMembersOptions) => async (c: Context<IdentityEnv>) => {
    const values = await invitationInput(c, options);
    const invitedRole = values ? role(formValue(values.form, "role")) : null;
    if (!values || !invitedRole) return failed(c, options);
    const result = await options.invite(
      { ...values.input, role: invitedRole } satisfies CreateInvitationInput,
      values.headers,
    );
    return result === "created" ? redirect("invited") : failed(c, options);
  };

export const createRevokeInvitationAction =
  (options: OrganizationMembersOptions) => async (c: Context<IdentityEnv>) => {
    const values = await invitationInput(c, options);
    if (!values) return failed(c, options);
    const result = await options.revokeInvitation(values.input, values.headers);
    return result === "revoked"
      ? redirect("invitation-revoked")
      : failed(c, options);
  };

export const createReissueInvitationAction =
  (options: OrganizationMembersOptions) => async (c: Context<IdentityEnv>) => {
    const values = await invitationInput(c, options);
    if (!values) return failed(c, options);
    const result = await options.reissueInvitation(
      values.input,
      values.headers,
    );
    return result === "reissued"
      ? redirect("invitation-reissued")
      : failed(c, options);
  };

export const createChangeMemberRoleAction =
  (options: OrganizationMembersOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const memberId = form ? formValue(form, "memberId") : "";
    const nextRole = form ? role(formValue(form, "role")) : null;
    if (
      !form ||
      !hasTrustedOrigin(c, options) ||
      !OPAQUE_ID.test(memberId) ||
      !nextRole
    ) {
      return failed(c, options);
    }
    const response = await options.request("/v1/members/role", {
      method: "POST",
      headers: forwardedHeaders(c, "application/json"),
      body: JSON.stringify({ memberId, role: nextRole }),
    });
    return response.ok ? redirect("role") : failed(c, options);
  };
