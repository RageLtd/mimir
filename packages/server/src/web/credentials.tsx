import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { canManageOrganization } from "../middleware/organization-roles";
import { attempt } from "../util/result";
import { DashboardNavigation, PageFrame } from "./chrome";

export type CredentialOptions = {
  origin: string;
  request: (path: string, init: RequestInit) => Response | Promise<Response>;
};

type CredentialState = {
  createdKey?: string;
  error?: boolean;
};

export const MAX_NAME_LENGTH = 100;
export const MAX_PASSWORD_LENGTH = 1_024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown) => (typeof value === "string" ? value : "");

const formatDate = (value: unknown) => {
  const date = new Date(text(value));
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString("en");
};

function requestHeaders(c: Context<IdentityEnv>, contentType?: string) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

export async function requestJson(
  c: Context<IdentityEnv>,
  options: CredentialOptions,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await options.request(path, {
    method: init.method ?? "GET",
    headers: requestHeaders(
      c,
      init.body === undefined ? undefined : "application/json",
    ),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const [error, body] = await attempt(() => response.json());
  return { response, body: error ? null : body };
}

async function loadCredentials(
  c: Context<IdentityEnv>,
  options: CredentialOptions,
) {
  const [current, sessions, apiKeys, passkeys, keyState] = await Promise.all([
    requestJson(c, options, "/api/auth/get-session"),
    requestJson(c, options, "/api/auth/list-sessions"),
    requestJson(c, options, "/api/auth/api-key/list"),
    requestJson(c, options, "/api/auth/passkey/list-user-passkeys"),
    requestJson(c, options, "/v1/keys/org"),
  ]);
  const currentSession = isRecord(current.body) ? current.body.session : null;
  const currentId = isRecord(currentSession) ? text(currentSession.id) : "";
  const sessionRows = Array.isArray(sessions.body) ? sessions.body : [];
  const apiKeyRows =
    isRecord(apiKeys.body) && Array.isArray(apiKeys.body.apiKeys)
      ? apiKeys.body.apiKeys
      : [];
  const passkeyRows = Array.isArray(passkeys.body) ? passkeys.body : [];
  const self =
    isRecord(keyState.body) && isRecord(keyState.body.self)
      ? keyState.body.self
      : {};
  return {
    sessions: sessionRows.flatMap((row) =>
      isRecord(row) && text(row.id)
        ? [
            {
              id: text(row.id),
              current: text(row.id) === currentId,
              userAgent: text(row.userAgent) || "Unknown browser",
              ipAddress: text(row.ipAddress) || "Unknown address",
              createdAt: formatDate(row.createdAt),
              expiresAt: formatDate(row.expiresAt),
            },
          ]
        : [],
    ),
    apiKeys: apiKeyRows.flatMap((row) =>
      isRecord(row) && text(row.id)
        ? [
            {
              id: text(row.id),
              name: text(row.name) || "Unnamed key",
              start: text(row.start) || text(row.prefix) || "Hidden",
              createdAt: formatDate(row.createdAt),
              lastRequest: row.lastRequest
                ? formatDate(row.lastRequest)
                : "Never",
            },
          ]
        : [],
    ),
    passkeys: passkeyRows.flatMap((row) =>
      isRecord(row) && text(row.id)
        ? [
            {
              id: text(row.id),
              name: text(row.name) || "Unnamed passkey",
              deviceType: text(row.deviceType) || "Authenticator",
              backedUp: row.backedUp === true,
              createdAt: formatDate(row.createdAt),
            },
          ]
        : [],
    ),
    keys: {
      publicKey: Boolean(self.publicKey),
      encryptedKeyset: Boolean(self.encryptedKeyset),
      orgWrap: Boolean(self.wrappedOrgKey),
      generation:
        isRecord(keyState.body) &&
        typeof keyState.body.keyGeneration === "number"
          ? keyState.body.keyGeneration
          : null,
    },
    unavailable:
      !current.response.ok ||
      !sessions.response.ok ||
      !apiKeys.response.ok ||
      !passkeys.response.ok ||
      !keyState.response.ok,
  };
}

const noticeText = (notice: string | undefined) => {
  if (notice === "password") return "Password updated.";
  if (notice === "session") return "Session revoked.";
  if (notice === "sessions") return "Other sessions revoked.";
  if (notice === "api-key") return "API key revoked.";
  if (notice === "passkey") return "Passkey updated.";
  return "";
};

export async function renderCredentials(
  c: Context<IdentityEnv>,
  options: CredentialOptions,
  state: CredentialState = {},
) {
  const data = await loadCredentials(c, options);
  const identity = c.get("identity");
  const notice = noticeText(c.req.query("notice"));
  c.header("cache-control", "private, no-store");
  c.status(state.error ? 400 : 200);
  return c.render(
    <PageFrame
      actions={<a href="/app">Dashboard</a>}
      navigation={
        <DashboardNavigation
          current="credentials"
          organizationAdmin={canManageOrganization(identity)}
        />
      }
    >
      <section aria-labelledby="credentials-title">
        <p class="kicker">Security</p>
        <h1 id="credentials-title">Credentials &amp; devices</h1>
        <p class="lede">
          Manage how browsers and agent clients reach this account.
        </p>
        {notice ? (
          <p class="notice" role="status">
            {notice}
          </p>
        ) : null}
        {state.error || data.unavailable ? (
          <p class="form-error" role="alert">
            Some credential data could not be loaded or changed.
          </p>
        ) : null}
        {state.createdKey ? (
          <section class="notice" aria-labelledby="new-key-title">
            <h2 id="new-key-title">Save this API key now</h2>
            <p>The full secret will not be shown again.</p>
            <output class="secret">{state.createdKey}</output>
          </section>
        ) : null}

        <div class="cards">
          <section class="card wide" aria-labelledby="device-title">
            <h2 id="device-title">This browser</h2>
            <dl class="status">
              <dt>Public key</dt>
              <dd>{data.keys.publicKey ? "Registered" : "Missing"}</dd>
              <dt>Encrypted keyset</dt>
              <dd>{data.keys.encryptedKeyset ? "Stored" : "Missing"}</dd>
              <dt>Organization wrap</dt>
              <dd>{data.keys.orgWrap ? "Available" : "Pending"}</dd>
              <dt>Generation</dt>
              <dd>{data.keys.generation ?? "Not initialized"}</dd>
            </dl>
            <mimir-credential-ceremony
              class="ceremony"
              data-user-id={identity?.userId}
            >
              <label for="passkey-name">Passkey name</label>
              <input
                id="passkey-name"
                name="passkeyName"
                maxlength={MAX_NAME_LENGTH}
                value="Browser device"
              />
              <label for="device-secret">
                Existing device secret{" "}
                <span class="muted">(new browsers only)</span>
              </label>
              <input
                id="device-secret"
                name="deviceSecret"
                type="password"
                autocomplete="off"
              />
              <div>
                <button class="button" type="button" data-action="register">
                  Add passkey
                </button>{" "}
                <button class="button" type="button" data-action="enroll">
                  Enroll browser
                </button>{" "}
                <button class="button" type="button" data-action="unlock">
                  Unlock
                </button>{" "}
                <button type="button" data-action="lock">
                  Lock
                </button>
              </div>
              <p role="status" aria-live="polite">
                WebAuthn and Web Crypto run only in this browser.
              </p>
              <output
                class="secret"
                data-device-secret
                aria-label="New device secret"
              />
              <noscript>
                <p>
                  Passkey registration and key unlock require JavaScript; the
                  credential lists and forms below remain available.
                </p>
              </noscript>
            </mimir-credential-ceremony>
          </section>

          <section class="card" aria-labelledby="password-title">
            <h2 id="password-title">Password</h2>
            <form
              class="stack"
              method="post"
              action="/app/credentials/password"
            >
              <label for="current-password">Current password</label>
              <input
                id="current-password"
                name="currentPassword"
                type="password"
                autocomplete="current-password"
                maxlength={MAX_PASSWORD_LENGTH}
                required
              />
              <label for="new-password">New password</label>
              <input
                id="new-password"
                name="newPassword"
                type="password"
                autocomplete="new-password"
                minlength={8}
                maxlength={MAX_PASSWORD_LENGTH}
                required
              />
              <label>
                <input name="revokeOtherSessions" type="checkbox" value="yes" />{" "}
                Revoke other sessions
              </label>
              <button class="button" type="submit">
                Change password
              </button>
            </form>
          </section>

          <section class="card" aria-labelledby="new-api-key-title">
            <h2 id="new-api-key-title">New API key</h2>
            <form
              class="stack"
              method="post"
              action="/app/credentials/api-keys"
            >
              <label for="api-key-name">Name</label>
              <input
                id="api-key-name"
                name="name"
                maxlength={MAX_NAME_LENGTH}
                required
              />
              <label for="api-key-password">Current password</label>
              <input
                id="api-key-password"
                name="currentPassword"
                type="password"
                autocomplete="current-password"
                maxlength={MAX_PASSWORD_LENGTH}
                required
              />
              <button class="button" type="submit">
                Create API key
              </button>
            </form>
          </section>

          <section class="card" aria-labelledby="sessions-title">
            <h2 id="sessions-title">Browser sessions</h2>
            <ul class="items">
              {data.sessions.map((session) => (
                <li class="item">
                  <div class="item-head">
                    <strong>
                      {session.current ? "This session" : session.userAgent}
                    </strong>
                    <span>{session.ipAddress}</span>
                  </div>
                  <p>
                    Created {session.createdAt}; expires {session.expiresAt}
                  </p>
                  <details>
                    <summary>Revoke session</summary>
                    <form
                      method="post"
                      action="/app/credentials/sessions/revoke"
                    >
                      <input type="hidden" name="id" value={session.id} />
                      <button type="submit">Confirm revoke</button>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
            <details>
              <summary>Revoke every other session</summary>
              <form
                method="post"
                action="/app/credentials/sessions/revoke-others"
              >
                <button type="submit">Confirm revoke others</button>
              </form>
            </details>
          </section>

          <section class="card" aria-labelledby="api-keys-title">
            <h2 id="api-keys-title">API keys</h2>
            <ul class="items">
              {data.apiKeys.map((key) => (
                <li class="item">
                  <strong>{key.name}</strong>
                  <p>
                    {key.start}… · created {key.createdAt} · last used{" "}
                    {key.lastRequest}
                  </p>
                  <details>
                    <summary>Revoke key</summary>
                    <form
                      method="post"
                      action="/app/credentials/api-keys/revoke"
                    >
                      <input type="hidden" name="id" value={key.id} />
                      <button type="submit">Confirm revoke</button>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section class="card wide" aria-labelledby="passkeys-title">
            <h2 id="passkeys-title">Passkeys</h2>
            <ul class="items">
              {data.passkeys.map((passkey) => (
                <li class="item">
                  <strong>{passkey.name}</strong>
                  <p>
                    {passkey.deviceType} ·{" "}
                    {passkey.backedUp ? "backed up" : "single device"} · added{" "}
                    {passkey.createdAt}
                  </p>
                  <form method="post" action="/app/credentials/passkeys/rename">
                    <input type="hidden" name="id" value={passkey.id} />
                    <label>
                      New name{" "}
                      <input name="name" maxlength={MAX_NAME_LENGTH} required />
                    </label>
                    <button type="submit">Rename</button>
                  </form>
                  <details>
                    <summary>Remove passkey</summary>
                    <form
                      method="post"
                      action="/app/credentials/passkeys/revoke"
                    >
                      <input type="hidden" name="id" value={passkey.id} />
                      <button type="submit">Confirm removal</button>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </section>
    </PageFrame>,
    {
      title: "Credentials — Mimir",
      description: "Manage Mimir credentials, sessions, passkeys, and devices.",
      scripts: ["/assets/credentials.js"],
    },
  );
}
