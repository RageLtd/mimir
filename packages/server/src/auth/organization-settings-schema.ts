export type OrganizationSettingField =
  | "name"
  | "slug"
  | "defaultInvitationRole"
  | "invitationLifetimeDays"
  | "auditRetentionDays";

export type DefaultInvitationRole = "admin" | "member";

export const MAX_ORGANIZATION_NAME_LENGTH = 80;
export const MIN_ORGANIZATION_SLUG_LENGTH = 3;
export const MAX_ORGANIZATION_SLUG_LENGTH = 48;
export const DEFAULT_INVITATION_ROLE: DefaultInvitationRole = "member";
export const DEFAULT_INVITATION_LIFETIME_DAYS = 2;
export const MIN_INVITATION_LIFETIME_DAYS = 1;
export const MAX_INVITATION_LIFETIME_DAYS = 30;
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const MIN_AUDIT_RETENTION_DAYS = 30;
export const MAX_AUDIT_RETENTION_DAYS = 2_555;

const ORGANIZATION_SETTING_FIELDS: readonly OrganizationSettingField[] = [
  "name",
  "slug",
  "defaultInvitationRole",
  "invitationLifetimeDays",
  "auditRetentionDays",
];
const ORGANIZATION_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function organizationName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= MAX_ORGANIZATION_NAME_LENGTH &&
    !hasControlCharacters(normalized)
    ? normalized
    : null;
}

export function organizationSlug(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length >= MIN_ORGANIZATION_SLUG_LENGTH &&
    normalized.length <= MAX_ORGANIZATION_SLUG_LENGTH &&
    ORGANIZATION_SLUG.test(normalized)
    ? normalized
    : null;
}

export function defaultInvitationRole(
  value: unknown,
): DefaultInvitationRole | null {
  return value === "admin" || value === "member" ? value : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

export function invitationLifetimeDays(value: unknown) {
  return boundedInteger(
    value,
    MIN_INVITATION_LIFETIME_DAYS,
    MAX_INVITATION_LIFETIME_DAYS,
  );
}

export function auditRetentionDays(value: unknown) {
  return boundedInteger(
    value,
    MIN_AUDIT_RETENTION_DAYS,
    MAX_AUDIT_RETENTION_DAYS,
  );
}

export function isOrganizationSettingField(
  value: unknown,
): value is OrganizationSettingField {
  return ORGANIZATION_SETTING_FIELDS.some((field) => field === value);
}

export function organizationSettingAuditValue(
  field: OrganizationSettingField,
  value: unknown,
) {
  switch (field) {
    case "name":
      return organizationName(value) ?? undefined;
    case "slug":
      return organizationSlug(value) ?? undefined;
    case "defaultInvitationRole":
      return defaultInvitationRole(value) ?? undefined;
    case "invitationLifetimeDays":
      return invitationLifetimeDays(value) ?? undefined;
    case "auditRetentionDays":
      return auditRetentionDays(value) ?? undefined;
  }
}
