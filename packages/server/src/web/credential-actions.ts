import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import {
  type CredentialOptions,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  renderCredentials,
  requestJson,
} from "./credentials";
import { EMPTY_FORM, formValue, hasTrustedOrigin, readForm } from "./forms";

const CREDENTIALS_PATH = "/app/credentials";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (value: unknown) => (typeof value === "string" ? value : "");

function redirectResult(response: Response, notice: string) {
  const headers = new Headers({
    "cache-control": "private, no-store",
    location: `${CREDENTIALS_PATH}?${new URLSearchParams({ notice })}`,
  });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

async function actionForm(c: Context<IdentityEnv>, options: CredentialOptions) {
  const form = await readForm(c);
  if (!form || !hasTrustedOrigin(c, options)) return null;
  return form;
}

export const createPasswordAction =
  (options: CredentialOptions) => async (c: Context<IdentityEnv>) => {
    const form = await actionForm(c, options);
    const values = form ?? EMPTY_FORM;
    const currentPassword = formValue(values, "currentPassword");
    const newPassword = formValue(values, "newPassword");
    if (
      !form ||
      currentPassword.length > MAX_PASSWORD_LENGTH ||
      newPassword.length < 8 ||
      newPassword.length > MAX_PASSWORD_LENGTH
    ) {
      return renderCredentials(c, options, { error: true });
    }
    const result = await requestJson(c, options, "/api/auth/change-password", {
      method: "POST",
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: formValue(values, "revokeOtherSessions") === "yes",
      },
    });
    return result.response.ok
      ? redirectResult(result.response, "password")
      : renderCredentials(c, options, { error: true });
  };

export const createApiKeyAction =
  (options: CredentialOptions) => async (c: Context<IdentityEnv>) => {
    const form = await actionForm(c, options);
    const values = form ?? EMPTY_FORM;
    const name = formValue(values, "name").trim();
    const currentPassword = formValue(values, "currentPassword");
    if (
      !form ||
      !name ||
      name.length > MAX_NAME_LENGTH ||
      !currentPassword ||
      currentPassword.length > MAX_PASSWORD_LENGTH
    ) {
      return renderCredentials(c, options, { error: true });
    }
    const verified = await requestJson(
      c,
      options,
      "/api/auth/verify-password",
      { method: "POST", body: { password: currentPassword } },
    );
    if (!verified.response.ok) {
      return renderCredentials(c, options, { error: true });
    }
    const created = await requestJson(c, options, "/api/auth/api-key/create", {
      method: "POST",
      body: { name },
    });
    const key = isRecord(created.body) ? text(created.body.key) : "";
    return created.response.ok && key
      ? renderCredentials(c, options, { createdKey: key })
      : renderCredentials(c, options, { error: true });
  };

async function sessionToken(
  c: Context<IdentityEnv>,
  options: CredentialOptions,
  id: string,
) {
  const listed = await requestJson(c, options, "/api/auth/list-sessions");
  if (!listed.response.ok || !Array.isArray(listed.body)) return "";
  for (const row of listed.body) {
    if (isRecord(row) && row.id === id) return text(row.token);
  }
  return "";
}

function simpleAction(
  options: CredentialOptions,
  path: string,
  body: (form: { get(name: string): unknown }) => unknown,
  notice: string,
) {
  return async (c: Context<IdentityEnv>) => {
    const form = await actionForm(c, options);
    if (!form) return renderCredentials(c, options, { error: true });
    const result = await requestJson(c, options, path, {
      method: "POST",
      body: body(form),
    });
    return result.response.ok
      ? redirectResult(result.response, notice)
      : renderCredentials(c, options, { error: true });
  };
}

export const createRevokeSessionAction =
  (options: CredentialOptions) => async (c: Context<IdentityEnv>) => {
    const form = await actionForm(c, options);
    if (!form) return renderCredentials(c, options, { error: true });
    const token = await sessionToken(c, options, formValue(form, "id"));
    if (!token) return renderCredentials(c, options, { error: true });
    const result = await requestJson(c, options, "/api/auth/revoke-session", {
      method: "POST",
      body: { token },
    });
    return result.response.ok
      ? redirectResult(result.response, "session")
      : renderCredentials(c, options, { error: true });
  };

export const createRevokeOtherSessionsAction = (options: CredentialOptions) =>
  simpleAction(
    options,
    "/api/auth/revoke-other-sessions",
    () => ({}),
    "sessions",
  );

export const createRevokeApiKeyAction = (options: CredentialOptions) =>
  simpleAction(
    options,
    "/api/auth/api-key/delete",
    (form) => ({ keyId: formValue(form, "id") }),
    "api-key",
  );

export const createRevokePasskeyAction = (options: CredentialOptions) =>
  simpleAction(
    options,
    "/api/auth/passkey/delete-passkey",
    (form) => ({ id: formValue(form, "id") }),
    "passkey",
  );

export const createRenamePasskeyAction = (options: CredentialOptions) =>
  simpleAction(
    options,
    "/api/auth/passkey/update-passkey",
    (form) => ({
      id: formValue(form, "id"),
      name: formValue(form, "name").trim(),
    }),
    "passkey",
  );
