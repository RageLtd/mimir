import type { Database } from "bun:sqlite";
import {
  appendAudit,
  failedAudit,
  type InstanceSettingField,
  OPERATOR_AUDIT_SCHEMA,
  type OperatorMutationInput,
} from "./audit";
import {
  boundedId,
  MAX_INSTANCE_NAME_LENGTH,
  MAX_SUPPORT_URL_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  normalizeEmail,
  normalizeName,
  normalizeSupportUrl,
  normalizeSystemPrompt,
  operatorTokenDigest,
  validToken,
} from "./validation";

export {
  type InstanceSettingField,
  listOperatorAudit,
  type OperatorAuditEvent,
  type OperatorMutationInput,
} from "./audit";
export {
  type ProvisionOrganizationInput,
  provisionOrganization,
} from "./provisioning";
export {
  MAX_INSTANCE_NAME_LENGTH,
  MAX_OPERATOR_TOKEN_LENGTH,
  MAX_SUPPORT_URL_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  MIN_OPERATOR_TOKEN_LENGTH,
  operatorTokenDigest,
} from "./validation";

export interface InstanceSettings {
  instanceName: string;
  supportUrl: string;
  systemPrompt: string | null;
  operatorMcpCredentialConfigured: boolean;
  updatedAt: string;
}

export interface OperatorGrantSummary {
  userId: string;
  name: string;
  email: string;
  grantedByUserId: string;
  createdAt: string;
}

interface SettingsRow {
  instanceName: string;
  supportUrl: string;
  systemPrompt: string | null;
  operatorMcpTokenDigest: string | null;
  updatedAt: string;
}

export interface UpdateInstanceSettingInput extends OperatorMutationInput {
  field: InstanceSettingField;
  value: string;
}

export interface ReplaceOperatorCredentialInput extends OperatorMutationInput {
  token: string;
}

export interface GrantOperatorInput extends OperatorMutationInput {
  email: string;
}

export interface RevokeOperatorInput extends OperatorMutationInput {
  userId: string;
}

export const OPERATOR_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS instance_setting (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  instance_name TEXT NOT NULL DEFAULT 'Mimir'
    CHECK(length(instance_name) BETWEEN 1 AND ${MAX_INSTANCE_NAME_LENGTH}),
  support_url TEXT NOT NULL DEFAULT ''
    CHECK(length(support_url) <= ${MAX_SUPPORT_URL_LENGTH}),
  system_prompt TEXT
    CHECK(system_prompt IS NULL OR length(system_prompt) BETWEEN 1 AND ${MAX_SYSTEM_PROMPT_LENGTH}),
  operator_mcp_token_digest TEXT
    CHECK(operator_mcp_token_digest IS NULL OR length(operator_mcp_token_digest) = 64),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS instance_operator_grant (
  user_id TEXT PRIMARY KEY,
  granted_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS instance_operator_bootstrap (
  user_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
${OPERATOR_AUDIT_SCHEMA}
`;

function nowIso(now: () => Date) {
  return now().toISOString();
}

export function migrateOperatorState(
  db: Database,
  options: {
    bootstrapUserIds?: readonly string[];
    systemPromptSeed?: string;
    now?: () => Date;
  } = {},
) {
  db.run(OPERATOR_STATE_SCHEMA);
  const now = options.now ?? (() => new Date());
  const seed = options.systemPromptSeed
    ? normalizeSystemPrompt(options.systemPromptSeed)
    : null;
  const timestamp = nowIso(now);
  db.transaction(() => {
    db.query(
      `INSERT OR IGNORE INTO instance_setting
        (id, instance_name, support_url, system_prompt, updated_at)
       VALUES (1, 'Mimir', '', ?, ?)`,
    ).run(seed, timestamp);
    if (seed) {
      db.query(
        `UPDATE instance_setting SET system_prompt = ?, updated_at = ?
          WHERE id = 1 AND system_prompt IS NULL`,
      ).run(seed, timestamp);
    }
    for (const userId of new Set(options.bootstrapUserIds ?? [])) {
      if (!boundedId(userId)) continue;
      const user = db.query('SELECT id FROM "user" WHERE id = ?').get(userId);
      if (!user) continue;
      const applied = db
        .query(
          `INSERT OR IGNORE INTO instance_operator_bootstrap
            (user_id, applied_at) VALUES (?, ?)`,
        )
        .run(userId, timestamp);
      if (applied.changes === 0) continue;
      const granted = db
        .query(
          `INSERT OR IGNORE INTO instance_operator_grant
          (user_id, granted_by_user_id, created_at) VALUES (?, ?, ?)`,
        )
        .run(userId, userId, timestamp);
      if (granted.changes > 0) {
        appendAudit(
          db,
          {
            actorUserId: userId,
            action: "operator.grant_created",
            targetType: "operator-grant",
            targetId: userId,
            outcome: "succeeded",
            requestId: crypto.randomUUID(),
          },
          now,
        );
      }
    }
  })();
}

export function grantInitialOperator(
  db: Database,
  userId: string,
  now: () => Date = () => new Date(),
) {
  if (!boundedId(userId)) return false;
  db.transaction(() => {
    const inserted = db
      .query(
        `INSERT OR IGNORE INTO instance_operator_grant
          (user_id, granted_by_user_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(userId, userId, nowIso(now));
    if (inserted.changes === 0) return;
    appendAudit(
      db,
      {
        actorUserId: userId,
        action: "operator.grant_created",
        targetType: "operator-grant",
        targetId: userId,
        outcome: "succeeded",
        requestId: crypto.randomUUID(),
      },
      now,
    );
  })();
  return true;
}

export function hasOperatorGrant(db: Database, userId: string) {
  if (!boundedId(userId)) return false;
  return Boolean(
    db
      .query("SELECT 1 FROM instance_operator_grant WHERE user_id = ?")
      .get(userId),
  );
}

export function listOperatorGrants(db: Database) {
  return db
    .query<OperatorGrantSummary, []>(
      `SELECT g.user_id AS userId, u.name, u.email,
              g.granted_by_user_id AS grantedByUserId,
              g.created_at AS createdAt
         FROM instance_operator_grant g
         JOIN "user" u ON u.id = g.user_id
        ORDER BY g.created_at, g.user_id`,
    )
    .all();
}

export function readInstanceSettings(db: Database) {
  const row = db
    .query<SettingsRow, []>(
      `SELECT instance_name AS instanceName, support_url AS supportUrl,
              system_prompt AS systemPrompt,
              operator_mcp_token_digest AS operatorMcpTokenDigest,
              updated_at AS updatedAt
         FROM instance_setting WHERE id = 1`,
    )
    .get();
  if (!row) throw new Error("instance settings are not initialized");
  return {
    instanceName: row.instanceName,
    supportUrl: row.supportUrl,
    systemPrompt: row.systemPrompt,
    operatorMcpCredentialConfigured: Boolean(row.operatorMcpTokenDigest),
    updatedAt: row.updatedAt,
  } satisfies InstanceSettings;
}

export function readOperatorCredentialDigest(db: Database) {
  const row = db
    .query<{ digest: string | null }, []>(
      `SELECT operator_mcp_token_digest AS digest
         FROM instance_setting WHERE id = 1`,
    )
    .get();
  return row?.digest ?? null;
}

export function updateInstanceSetting(
  db: Database,
  input: UpdateInstanceSettingInput,
  now: () => Date = () => new Date(),
) {
  const normalized =
    input.field === "instance_name"
      ? normalizeName(input.value)
      : input.field === "support_url"
        ? normalizeSupportUrl(input.value)
        : normalizeSystemPrompt(input.value);
  const trusted =
    input.recentAuthentication &&
    boundedId(input.actorUserId) &&
    boundedId(input.requestId);
  if (!trusted || normalized === null) {
    failedAudit(
      db,
      input,
      "instance.settings_changed",
      "instance-setting",
      input.field,
      now,
      input.field,
    );
    return "rejected";
  }
  const column =
    input.field === "instance_name"
      ? "instance_name"
      : input.field === "support_url"
        ? "support_url"
        : "system_prompt";
  db.transaction(() => {
    db.query(
      `UPDATE instance_setting SET ${column} = ?, updated_at = ? WHERE id = 1`,
    ).run(normalized, nowIso(now));
    appendAudit(
      db,
      {
        actorUserId: input.actorUserId,
        action: "instance.settings_changed",
        targetType: "instance-setting",
        targetId: input.field,
        outcome: "succeeded",
        requestId: input.requestId,
        field: input.field,
      },
      now,
    );
  })();
  return "updated";
}

export function replaceOperatorCredential(
  db: Database,
  input: ReplaceOperatorCredentialInput,
  now: () => Date = () => new Date(),
) {
  const trusted =
    input.recentAuthentication &&
    boundedId(input.actorUserId) &&
    boundedId(input.requestId);
  if (!trusted || !validToken(input.token)) {
    failedAudit(
      db,
      input,
      "operator.credential_replaced",
      "operator-credential",
      "mcp",
      now,
    );
    return "rejected";
  }
  db.transaction(() => {
    db.query(
      `UPDATE instance_setting
          SET operator_mcp_token_digest = ?, updated_at = ? WHERE id = 1`,
    ).run(operatorTokenDigest(input.token), nowIso(now));
    appendAudit(
      db,
      {
        actorUserId: input.actorUserId,
        action: "operator.credential_replaced",
        targetType: "operator-credential",
        targetId: "mcp",
        outcome: "succeeded",
        requestId: input.requestId,
      },
      now,
    );
  })();
  return "updated";
}

export function grantOperator(
  db: Database,
  input: GrantOperatorInput,
  now: () => Date = () => new Date(),
) {
  const email = normalizeEmail(input.email);
  const trusted =
    input.recentAuthentication &&
    boundedId(input.actorUserId) &&
    boundedId(input.requestId);
  const user = email
    ? db
        .query<{ id: string }, [string]>(
          'SELECT id FROM "user" WHERE lower(email) = lower(?)',
        )
        .get(email)
    : null;
  if (!trusted || !user || !boundedId(user.id)) {
    failedAudit(
      db,
      input,
      "operator.grant_created",
      "operator-grant",
      "operator:unknown",
      now,
    );
    return "rejected";
  }
  const inserted = db.transaction(() => {
    const result = db
      .query(
        `INSERT OR IGNORE INTO instance_operator_grant
          (user_id, granted_by_user_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(user.id, input.actorUserId, nowIso(now));
    appendAudit(
      db,
      {
        actorUserId: input.actorUserId,
        action: "operator.grant_created",
        targetType: "operator-grant",
        targetId: user.id,
        outcome: "succeeded",
        requestId: input.requestId,
      },
      now,
    );
    return result.changes;
  })();
  return inserted > 0 ? "created" : "unchanged";
}

export function revokeOperator(
  db: Database,
  input: RevokeOperatorInput,
  now: () => Date = () => new Date(),
) {
  const trusted =
    input.recentAuthentication &&
    boundedId(input.actorUserId) &&
    boundedId(input.requestId) &&
    boundedId(input.userId);
  return db.transaction(() => {
    const count = db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM instance_operator_grant",
      )
      .get()?.count;
    if (!trusted || !count || count <= 1) {
      failedAudit(
        db,
        input,
        "operator.grant_revoked",
        "operator-grant",
        boundedId(input.userId) ?? "operator:unknown",
        now,
      );
      return "rejected";
    }
    const result = db
      .query("DELETE FROM instance_operator_grant WHERE user_id = ?")
      .run(input.userId);
    appendAudit(
      db,
      {
        actorUserId: input.actorUserId,
        action: "operator.grant_revoked",
        targetType: "operator-grant",
        targetId: input.userId,
        outcome: result.changes > 0 ? "succeeded" : "failed",
        requestId: input.requestId,
      },
      now,
    );
    return result.changes > 0 ? "revoked" : "rejected";
  })();
}
