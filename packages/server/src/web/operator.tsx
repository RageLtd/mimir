import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import * as paths from "../operator/paths";
import type {
  GrantOperatorInput,
  InstanceSettings,
  OperatorAuditEvent,
  OperatorGrantSummary,
  ProvisionOrganizationInput,
  ReplaceOperatorCredentialInput,
  RevokeOperatorInput,
  UpdateInstanceSettingInput,
} from "../operator/state";
import {
  MAX_INSTANCE_NAME_LENGTH,
  MAX_OPERATOR_TOKEN_LENGTH,
  MAX_SUPPORT_URL_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  MIN_OPERATOR_TOKEN_LENGTH,
} from "../operator/state";
import { attemptSync } from "../util/result";
import {
  type OperatorPageState,
  operatorErrorMessage,
  operatorFrame,
  operatorNotice,
} from "./operator-frame";

export interface OperatorHealth {
  version: string;
  tenantStore: "ok" | "down";
  userCount: number;
  organizationCount: number;
  operatorCount: number;
}

export interface OperatorDashboardOptions {
  origin: string;
  now?: () => number;
  readSettings: () => InstanceSettings;
  listGrants: () => OperatorGrantSummary[];
  listAudit: () => OperatorAuditEvent[];
  readHealth: () => OperatorHealth;
  updateSetting: (input: UpdateInstanceSettingInput) => string;
  replaceCredential: (input: ReplaceOperatorCredentialInput) => string;
  grant: (input: GrantOperatorInput) => string;
  revoke: (input: RevokeOperatorInput) => string;
  provision: (input: ProvisionOrganizationInput) => string;
}

export function renderOperatorHome(c: Context<IdentityEnv>) {
  const identity = c.get("operatorIdentity");
  c.header("cache-control", "private, no-store");
  return c.render(
    operatorFrame(
      c,
      "operator-overview",
      <section aria-labelledby="operator-title" data-user-id={identity?.userId}>
        <p class="kicker">Server operation</p>
        <h1 id="operator-title">Operate this Mimir instance</h1>
        <p class="lede">
          Server authority is separate from every organization. Tenant data,
          encryption keys, and organization administration are not available
          here.
        </p>
        <div class="cards">
          <section class="card">
            <h2>
              <a href={paths.OPERATOR_SETTINGS_PATH}>Runtime settings</a>
            </h2>
            <p>
              Manage bounded instance settings and one-way credential
              replacement.
            </p>
          </section>
          <section class="card">
            <h2>
              <a href={paths.OPERATOR_ORGANIZATIONS_PATH}>
                Tenant provisioning
              </a>
            </h2>
            <p>
              Create an organization with an initial-owner invitation without
              joining it.
            </p>
          </section>
          <section class="card">
            <h2>
              <a href={paths.OPERATOR_GRANTS_PATH}>Operator grants</a>
            </h2>
            <p>Manage the explicit instance-level operator allowlist.</p>
          </section>
          <section class="card">
            <h2>
              <a href={paths.OPERATOR_HEALTH_PATH}>Instance health</a>
            </h2>
            <p>Review bounded health and aggregate operational metadata.</p>
          </section>
          <section class="card">
            <h2>
              <a href={paths.OPERATOR_AUDIT_PATH}>Operator audit</a>
            </h2>
            <p>Review append-only instance administration events.</p>
          </section>
        </div>
      </section>,
    ),
    {
      title: "Server operation — Mimir",
      description: "Operate this Mimir server instance.",
      styles: ["dashboard", "card", "cards"],
    },
  );
}

export function renderOperatorSettings(
  c: Context<IdentityEnv>,
  options: OperatorDashboardOptions,
  state: OperatorPageState = {},
) {
  const [error, settings] = attemptSync(options.readSettings);
  if (error || !settings) return c.text("Unavailable", 503);
  c.header("cache-control", "private, no-store");
  return c.render(
    operatorFrame(
      c,
      "operator-settings",
      <section aria-labelledby="operator-settings-title">
        <p class="kicker">Server operation</p>
        <h1 id="operator-settings-title">Runtime settings</h1>
        <p class="lede">
          Only settings that can safely take effect without a restart are
          exposed.
        </p>
        {operatorNotice(c) === "setting" ? (
          <p class="notice" role="status">
            Setting updated.
          </p>
        ) : null}
        {operatorNotice(c) === "credential" ? (
          <p class="notice" role="status">
            Operator MCP credential replaced.
          </p>
        ) : null}
        {operatorErrorMessage(state)}
        <div class="cards">
          <section class="card">
            <h2>Instance name</h2>
            <form
              class="stack"
              method="post"
              action={paths.OPERATOR_SETTINGS_NAME_PATH}
            >
              <label for="instance-name">Name</label>
              <input
                id="instance-name"
                name="value"
                value={settings.instanceName}
                maxlength={MAX_INSTANCE_NAME_LENGTH}
                required
              />
              <button class="button" type="submit">
                Update name
              </button>
            </form>
          </section>
          <section class="card">
            <h2>Support URL</h2>
            <form
              class="stack"
              method="post"
              action={paths.OPERATOR_SETTINGS_SUPPORT_URL_PATH}
            >
              <label for="support-url">
                HTTPS URL <span class="muted">optional</span>
              </label>
              <input
                id="support-url"
                name="value"
                type="url"
                value={settings.supportUrl}
                maxlength={MAX_SUPPORT_URL_LENGTH}
              />
              <button class="button" type="submit">
                Update support URL
              </button>
            </form>
          </section>
          <section class="card wide">
            <h2>System prompt</h2>
            <p>
              Clients receive this server-wide prompt. Its content is never
              copied into the operator audit log.
            </p>
            <form
              class="stack"
              method="post"
              action={paths.OPERATOR_SETTINGS_SYSTEM_PROMPT_PATH}
            >
              <label for="system-prompt">Markdown</label>
              <textarea
                id="system-prompt"
                name="value"
                maxlength={MAX_SYSTEM_PROMPT_LENGTH}
                required
              >
                {settings.systemPrompt ?? ""}
              </textarea>
              <button class="button" type="submit">
                Update system prompt
              </button>
            </form>
          </section>
          <section class="card wide">
            <h2>Operator MCP credential</h2>
            <p>
              Stored replacement:{" "}
              {settings.operatorMcpCredentialConfigured
                ? "configured"
                : "not set"}
              . The current credential and its digest are never displayed.
            </p>
            <form
              class="stack"
              method="post"
              action={paths.OPERATOR_SETTINGS_MCP_CREDENTIAL_PATH}
            >
              <label for="operator-mcp-token">New high-entropy token</label>
              <input
                id="operator-mcp-token"
                name="token"
                type="password"
                minlength={MIN_OPERATOR_TOKEN_LENGTH}
                maxlength={MAX_OPERATOR_TOKEN_LENGTH}
                autocomplete="new-password"
                required
              />
              <button class="button" type="submit">
                Replace credential
              </button>
            </form>
          </section>
        </div>
      </section>,
    ),
    {
      title: "Runtime settings — Mimir",
      description: "Manage bounded runtime settings for this Mimir instance.",
      styles: ["dashboard", "card", "cards", "forms"],
    },
  );
}

export function renderOperatorOrganizations(
  c: Context<IdentityEnv>,
  state: OperatorPageState = {},
) {
  c.header("cache-control", "private, no-store");
  return c.render(
    operatorFrame(
      c,
      "operator-organizations",
      <section aria-labelledby="operator-organizations-title">
        <p class="kicker">Server operation</p>
        <h1 id="operator-organizations-title">Provision an organization</h1>
        <p class="lede">
          The organization and initial-owner invitation are created atomically.
          The operator is not enrolled.
        </p>
        {operatorNotice(c) === "provision" ? (
          <p class="notice" role="status">
            Organization provisioned and owner invited.
          </p>
        ) : null}
        {operatorErrorMessage(state)}
        <section class="card">
          <form
            class="stack"
            method="post"
            action={paths.OPERATOR_ORGANIZATIONS_PROVISION_PATH}
          >
            <label for="organization-name">Organization name</label>
            <input
              id="organization-name"
              name="name"
              maxlength={MAX_INSTANCE_NAME_LENGTH}
              required
            />
            <label for="organization-slug">Organization slug</label>
            <input
              id="organization-slug"
              name="slug"
              minlength={3}
              maxlength={64}
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
              required
            />
            <label for="owner-email">Initial owner email</label>
            <input
              id="owner-email"
              name="ownerEmail"
              type="email"
              maxlength={320}
              autocomplete="email"
              required
            />
            <button class="button" type="submit">
              Provision organization
            </button>
          </form>
        </section>
      </section>,
    ),
    {
      title: "Tenant provisioning — Mimir",
      description: "Provision a new Mimir organization.",
      styles: ["dashboard", "card", "forms"],
    },
  );
}

export function renderOperatorGrants(
  c: Context<IdentityEnv>,
  options: OperatorDashboardOptions,
  state: OperatorPageState = {},
) {
  const [error, grants] = attemptSync(options.listGrants);
  if (error || !grants) return c.text("Unavailable", 503);
  c.header("cache-control", "private, no-store");
  return c.render(
    operatorFrame(
      c,
      "operator-grants",
      <section aria-labelledby="operator-grants-title">
        <p class="kicker">Server operation</p>
        <h1 id="operator-grants-title">Operator grants</h1>
        <p class="lede">
          Grants are checked from server state on every request. Organization
          roles have no effect here.
        </p>
        {operatorNotice(c) === "grant" ? (
          <p class="notice" role="status">
            Operator grant applied.
          </p>
        ) : null}
        {operatorNotice(c) === "revoke" ? (
          <p class="notice" role="status">
            Operator grant revoked.
          </p>
        ) : null}
        {operatorErrorMessage(state)}
        <div class="cards">
          <section class="card">
            <h2>Grant operator access</h2>
            <form
              class="stack"
              method="post"
              action={paths.OPERATOR_GRANT_PATH}
            >
              <label for="operator-email">Existing account email</label>
              <input
                id="operator-email"
                name="email"
                type="email"
                maxlength={320}
                autocomplete="email"
                required
              />
              <button class="button" type="submit">
                Grant access
              </button>
            </form>
          </section>
          <section class="card wide">
            <h2>Current operators</h2>
            <ul class="items">
              {grants.map((grant) => (
                <li class="item">
                  <div class="item-head">
                    <span>
                      <strong>{grant.name}</strong>
                      <br />
                      <span class="muted">{grant.email}</span>
                    </span>
                    <code>{grant.userId}</code>
                  </div>
                  <form method="post" action={paths.OPERATOR_REVOKE_PATH}>
                    <input type="hidden" name="userId" value={grant.userId} />
                    <button class="button" type="submit">
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </section>,
    ),
    {
      title: "Operator grants — Mimir",
      description: "Manage explicit instance operator grants.",
      styles: ["dashboard", "card", "cards", "forms", "lists", "listHeads"],
    },
  );
}

export function renderOperatorHealth(
  c: Context<IdentityEnv>,
  options: OperatorDashboardOptions,
) {
  const [error, health] = attemptSync(options.readHealth);
  if (error || !health) return c.text("Unavailable", 503);
  c.header("cache-control", "private, no-store");
  return c.render(
    operatorFrame(
      c,
      "operator-health",
      <section aria-labelledby="operator-health-title">
        <p class="kicker">Server operation</p>
        <h1 id="operator-health-title">Instance health</h1>
        <p class="lede">
          Aggregate metadata only. Organization names, members, memory contents,
          and keys are excluded.
        </p>
        <section class="card">
          <dl class="status">
            <dt>Version</dt>
            <dd>{health.version}</dd>
            <dt>Tenant store</dt>
            <dd>{health.tenantStore}</dd>
            <dt>Users</dt>
            <dd>{health.userCount}</dd>
            <dt>Organizations</dt>
            <dd>{health.organizationCount}</dd>
            <dt>Operators</dt>
            <dd>{health.operatorCount}</dd>
          </dl>
        </section>
      </section>,
    ),
    {
      title: "Instance health — Mimir",
      description: "Review bounded Mimir instance health metadata.",
      styles: ["dashboard", "card", "status"],
    },
  );
}

export function renderOperatorAudit(
  c: Context<IdentityEnv>,
  options: OperatorDashboardOptions,
) {
  const [error, events] = attemptSync(options.listAudit);
  if (error || !events) return c.text("Unavailable", 503);
  c.header("cache-control", "private, no-store");
  return c.render(
    operatorFrame(
      c,
      "operator-audit",
      <section aria-labelledby="operator-audit-title">
        <p class="kicker">Server operation</p>
        <h1 id="operator-audit-title">Operator audit</h1>
        <p class="lede">
          Recent instance administration outcomes. Secret and setting values are
          never recorded.
        </p>
        <ul class="items audit-events">
          {events.map((event) => (
            <li class="item">
              <div class="item-head">
                <strong>{event.action}</strong>
                <time datetime={event.createdAt}>{event.createdAt}</time>
              </div>
              <p>
                {event.outcome} · actor <code>{event.actorUserId}</code> ·{" "}
                {event.targetType} <code>{event.targetId}</code>
              </p>
            </li>
          ))}
        </ul>
      </section>,
    ),
    {
      title: "Operator audit — Mimir",
      description: "Review instance operator audit events.",
      styles: ["dashboard", "lists", "listHeads", "activity"],
    },
  );
}
