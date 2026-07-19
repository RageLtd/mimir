import type { Database } from "bun:sqlite";
import { DEFAULT_INVITATION_LIFETIME_DAYS } from "../auth/organization-settings-schema";
import { attemptSync } from "../util/result";
import { appendAudit, failedAudit, type OperatorMutationInput } from "./audit";
import {
  boundedId,
  normalizeEmail,
  normalizeName,
  normalizeSlug,
} from "./validation";

export interface ProvisionOrganizationInput extends OperatorMutationInput {
  name: string;
  slug: string;
  ownerEmail: string;
}

export function provisionOrganization(
  db: Database,
  input: ProvisionOrganizationInput,
  now: () => Date = () => new Date(),
) {
  const name = normalizeName(input.name);
  const slug = normalizeSlug(input.slug);
  const ownerEmail = normalizeEmail(input.ownerEmail);
  const trusted =
    input.recentAuthentication &&
    boundedId(input.actorUserId) &&
    boundedId(input.requestId);
  if (!trusted || !name || !slug || !ownerEmail) {
    failedAudit(
      db,
      input,
      "organization.provisioned",
      "organization",
      "organization:unknown",
      now,
    );
    return "rejected";
  }
  const organizationId = crypto.randomUUID();
  const invitationId = crypto.randomUUID();
  const timestamp = now().toISOString();
  const expiresAt = new Date(
    now().valueOf() + DEFAULT_INVITATION_LIFETIME_DAYS * 86_400_000,
  ).toISOString();
  const [error] = attemptSync(() =>
    db.transaction(() => {
      db.query(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, ?, ?, ?)`,
      ).run(organizationId, name, slug, timestamp);
      db.query(
        `INSERT INTO invitation
          (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
         VALUES (?, ?, ?, 'owner', 'pending', ?, ?, ?)`,
      ).run(
        invitationId,
        organizationId,
        ownerEmail,
        expiresAt,
        timestamp,
        input.actorUserId,
      );
      appendAudit(
        db,
        {
          actorUserId: input.actorUserId,
          action: "organization.provisioned",
          targetType: "organization",
          targetId: organizationId,
          outcome: "succeeded",
          requestId: input.requestId,
        },
        now,
      );
    })(),
  );
  if (!error) return "created";
  failedAudit(
    db,
    input,
    "organization.provisioned",
    "organization",
    "organization:unknown",
    now,
  );
  return "rejected";
}
