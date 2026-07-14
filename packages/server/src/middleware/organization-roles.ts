import type { ResolvedIdentity } from "./identity";

const ADMIN_ROLES = new Set(["owner", "admin"]);

export function canManageOrganization(identity: ResolvedIdentity | undefined) {
  return Boolean(
    identity?.organizationRoles?.some((role) => ADMIN_ROLES.has(role)),
  );
}
