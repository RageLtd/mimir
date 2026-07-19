import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { isTrustedRecentBrowser } from "../middleware/recent-browser";
import * as paths from "../operator/paths";
import type { InstanceSettingField } from "../operator/state";
import { attemptSync } from "../util/result";
import { formValue, hasTrustedOrigin, readForm } from "./forms";
import {
  type OperatorDashboardOptions,
  renderOperatorGrants,
  renderOperatorOrganizations,
  renderOperatorSettings,
} from "./operator";

const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;

function requestId(c: Context<IdentityEnv>) {
  const value = c.req.header("x-request-id");
  return value && OPAQUE_ID.test(value) ? value : crypto.randomUUID();
}

function redirect(path: string, notice: string) {
  return new Response(null, {
    status: 303,
    headers: {
      "cache-control": "private, no-store",
      location: `${path}?${new URLSearchParams({ notice })}`,
    },
  });
}

function mutationInput(
  c: Context<IdentityEnv>,
  options: OperatorDashboardOptions,
) {
  const identity = c.get("operatorIdentity");
  if (!identity || !hasTrustedOrigin(c, options)) return null;
  return {
    actorUserId: identity.userId,
    requestId: requestId(c),
    recentAuthentication: isTrustedRecentBrowser(
      c,
      options.origin,
      options.now ?? Date.now,
    ),
  };
}

export const createInstanceSettingAction =
  (options: OperatorDashboardOptions, field: InstanceSettingField) =>
  async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const mutation = mutationInput(c, options);
    if (!form || !mutation) {
      return renderOperatorSettings(c, options, { error: true });
    }
    const [error, result] = attemptSync(() =>
      options.updateSetting({
        ...mutation,
        field,
        value: formValue(form, "value"),
      }),
    );
    return !error && result === "updated"
      ? redirect(paths.OPERATOR_SETTINGS_PATH, "setting")
      : renderOperatorSettings(c, options, { error: true });
  };

export const createOperatorCredentialAction =
  (options: OperatorDashboardOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const mutation = mutationInput(c, options);
    if (!form || !mutation) {
      return renderOperatorSettings(c, options, { error: true });
    }
    const [error, result] = attemptSync(() =>
      options.replaceCredential({
        ...mutation,
        token: formValue(form, "token"),
      }),
    );
    return !error && result === "updated"
      ? redirect(paths.OPERATOR_SETTINGS_PATH, "credential")
      : renderOperatorSettings(c, options, { error: true });
  };

export const createGrantOperatorAction =
  (options: OperatorDashboardOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const mutation = mutationInput(c, options);
    if (!form || !mutation) {
      return renderOperatorGrants(c, options, { error: true });
    }
    const [error, result] = attemptSync(() =>
      options.grant({ ...mutation, email: formValue(form, "email") }),
    );
    return !error && (result === "created" || result === "unchanged")
      ? redirect(paths.OPERATOR_GRANTS_PATH, "grant")
      : renderOperatorGrants(c, options, { error: true });
  };

export const createRevokeOperatorAction =
  (options: OperatorDashboardOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const mutation = mutationInput(c, options);
    if (!form || !mutation) {
      return renderOperatorGrants(c, options, { error: true });
    }
    const [error, result] = attemptSync(() =>
      options.revoke({ ...mutation, userId: formValue(form, "userId") }),
    );
    return !error && result === "revoked"
      ? redirect(paths.OPERATOR_GRANTS_PATH, "revoke")
      : renderOperatorGrants(c, options, { error: true });
  };

export const createProvisionOrganizationAction =
  (options: OperatorDashboardOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const mutation = mutationInput(c, options);
    if (!form || !mutation) {
      return renderOperatorOrganizations(c, { error: true });
    }
    const [error, result] = attemptSync(() =>
      options.provision({
        ...mutation,
        name: formValue(form, "name"),
        slug: formValue(form, "slug"),
        ownerEmail: formValue(form, "ownerEmail"),
      }),
    );
    return !error && result === "created"
      ? redirect(paths.OPERATOR_ORGANIZATIONS_PATH, "provision")
      : renderOperatorOrganizations(c, { error: true });
  };
