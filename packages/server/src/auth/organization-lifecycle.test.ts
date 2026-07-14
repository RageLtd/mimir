import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { migrateOrganizationAudit } from "../audit/store";
import { createTenantDb } from "../db/tenant";
import { buildAuthOptions } from "./instance";
import {
  cancelOrganizationDeletion,
  migrateOrganizationLifecycle,
  ORGANIZATION_DELETION_GRACE_DAYS,
  purgeDueOrganizations,
  readOrganizationLifecycle,
  scheduleOrganizationDeletion,
} from "./organization-lifecycle";
import { migrateOrganizationPolicy } from "./organization-policy";

const TEST_SECRET = "test-secret-material-at-least-32-chars-long";
const NOW = new Date("2026-07-14T06:00:00.000Z");

function cookieFrom(response: { headers: Headers }) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function world() {
  const authDb = new Database(":memory:");
  const options = buildAuthOptions(authDb, TEST_SECRET);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  migrateOrganizationAudit(authDb);
  migrateOrganizationPolicy(authDb);
  migrateOrganizationLifecycle(authDb);
  const auth = betterAuth(options);

  const ownerA = await auth.api.signUpEmail({
    body: {
      name: "First Owner",
      email: "first-owner@example.test",
      password: "owner-password-123",
      publicKey: "public-owner-a",
    },
    returnHeaders: true,
  });
  const headersA = new Headers({ cookie: cookieFrom(ownerA) });
  const orgA = await auth.api.createOrganization({
    body: { name: "First Org", slug: "first-org" },
    headers: headersA,
  });
  authDb
    .query(
      "UPDATE member SET wrappedOrgKey = 'wrapped-owner-a' WHERE organizationId = ? AND userId = ?",
    )
    .run(orgA.id, ownerA.response.user.id);
  authDb
    .query("UPDATE session SET activeOrganizationId = ? WHERE userId = ?")
    .run(orgA.id, ownerA.response.user.id);

  const ownerB = await auth.api.signUpEmail({
    body: {
      name: "Second Owner",
      email: "second-owner@example.test",
      password: "owner-password-456",
      publicKey: "public-owner-b",
    },
    returnHeaders: true,
  });
  const headersB = new Headers({ cookie: cookieFrom(ownerB) });
  const orgB = await auth.api.createOrganization({
    body: { name: "Second Org", slug: "second-org" },
    headers: headersB,
  });
  authDb
    .query(
      "UPDATE member SET wrappedOrgKey = 'wrapped-owner-b' WHERE organizationId = ? AND userId = ?",
    )
    .run(orgB.id, ownerB.response.user.id);
  authDb
    .query("UPDATE session SET activeOrganizationId = ? WHERE userId = ?")
    .run(orgB.id, ownerB.response.user.id);

  const tenantDb = createTenantDb(":memory:");
  for (const orgId of [orgA.id, orgB.id]) {
    tenantDb
      .query(
        `INSERT INTO envelope
          (id, org_id, kind, envelope_v, suite, key_gen, version, tombstone, nonce, payload)
         VALUES (?, ?, 1, 2, 1, 1, 1, 0, 'AAECAwQFBgcICQoL', 'AAECAwQFBgcICQoLDA0ODw')`,
      )
      .run(`memory:${orgId}`, orgId);
    tenantDb
      .query(
        "INSERT INTO sync_cursor (org_id, user_id, cursor) VALUES (?, ?, 1)",
      )
      .run(orgId, `user:${orgId}`);
    tenantDb
      .query(
        "INSERT INTO lease (org_id, name, holder, expires_at) VALUES (?, 'hygiene', ?, ?)",
      )
      .run(orgId, `user:${orgId}`, NOW.valueOf() + 60_000);
    tenantDb
      .query(
        "INSERT INTO project (id, org_id, title) VALUES (?, ?, 'Legacy metadata')",
      )
      .run(`project:${orgId}`, orgId);
  }

  return {
    authDb,
    tenantDb,
    orgA,
    orgB,
    ownerA: ownerA.response.user,
    ownerB: ownerB.response.user,
  };
}

function scheduleInput(orgId: string, actorUserId: string) {
  return {
    orgId,
    actorUserId,
    requestId: "request-schedule",
    confirmation: "First Org",
    recentAuthentication: true,
  };
}

describe("organization lifecycle", () => {
  test("schedules only for a current owner with recent auth and exact confirmation", async () => {
    const { authDb, orgA, ownerA } = await world();
    const input = scheduleInput(orgA.id, ownerA.id);
    authDb
      .query(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('admin-user', 'Admin', 'admin@example.test', 1, ?, ?)`,
      )
      .run(NOW.toISOString(), NOW.toISOString());
    authDb
      .query(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES ('member-admin', ?, 'admin-user', 'admin', ?)`,
      )
      .run(orgA.id, NOW.toISOString());

    expect(
      scheduleOrganizationDeletion(authDb, {
        ...input,
        actorUserId: "admin-user",
      }),
    ).toBe("forbidden");
    expect(
      scheduleOrganizationDeletion(authDb, {
        ...input,
        recentAuthentication: false,
      }),
    ).toBe("forbidden");
    expect(
      scheduleOrganizationDeletion(authDb, {
        ...input,
        confirmation: "first-org",
      }),
    ).toBe("validation");
    expect(
      scheduleOrganizationDeletion(
        authDb,
        input,
        () => "schedule-id",
        () => NOW,
      ),
    ).toBe("scheduled");
    expect(scheduleOrganizationDeletion(authDb, input)).toBe("conflict");

    expect(readOrganizationLifecycle(authDb, orgA.id)).toEqual({
      ownerCount: 1,
      keyedOwnerCount: 1,
      deletion: {
        scheduleId: "schedule:schedule-id",
        scheduledAt: NOW.toISOString(),
        purgeAfter: new Date(
          NOW.valueOf() + ORGANIZATION_DELETION_GRACE_DAYS * 86_400_000,
        ).toISOString(),
        status: "scheduled",
      },
    });
  });

  test("cancellation requires the same schedule and an active recent owner", async () => {
    const { authDb, orgA, ownerA } = await world();
    const input = scheduleInput(orgA.id, ownerA.id);
    scheduleOrganizationDeletion(
      authDb,
      input,
      () => "cancel-me",
      () => NOW,
    );
    const cancellation = {
      orgId: orgA.id,
      actorUserId: ownerA.id,
      requestId: "request-cancel",
      scheduleId: "schedule:cancel-me",
      recentAuthentication: true,
    };

    expect(
      cancelOrganizationDeletion(authDb, {
        ...cancellation,
        scheduleId: "schedule:stale",
      }),
    ).toBe("conflict");
    expect(
      cancelOrganizationDeletion(authDb, {
        ...cancellation,
        recentAuthentication: false,
      }),
    ).toBe("forbidden");
    expect(cancelOrganizationDeletion(authDb, cancellation)).toBe(
      "cancelled",
    );
    expect(readOrganizationLifecycle(authDb, orgA.id)?.deletion).toBeNull();
  });

  test("purges only due organization state and leaves a minimal receipt", async () => {
    const { authDb, tenantDb, orgA, orgB, ownerA } = await world();
    scheduleOrganizationDeletion(
      authDb,
      scheduleInput(orgA.id, ownerA.id),
      () => "purge-me",
      () => NOW,
    );
    const beforeDeadline = new Date(
      NOW.valueOf() + ORGANIZATION_DELETION_GRACE_DAYS * 86_400_000 - 1,
    );
    expect(purgeDueOrganizations(authDb, tenantDb, () => beforeDeadline)).toEqual(
      [],
    );

    const deadline = new Date(beforeDeadline.valueOf() + 1);
    expect(purgeDueOrganizations(authDb, tenantDb, () => deadline)).toEqual([
      { orgId: orgA.id, status: "purged" },
    ]);
    expect(
      authDb.query("SELECT id FROM organization WHERE id = ?").get(orgA.id),
    ).toBeNull();
    expect(
      authDb.query("SELECT id FROM organization WHERE id = ?").get(orgB.id),
    ).not.toBeNull();
    expect(
      authDb
        .query<{ activeOrganizationId: string | null }, [string]>(
          "SELECT activeOrganizationId FROM session WHERE userId = ?",
        )
        .get(ownerA.id)?.activeOrganizationId,
    ).toBeNull();
    for (const table of ["envelope", "sync_cursor", "lease"]) {
      expect(
        tenantDb
          .query<{ count: number }, [string]>(
            `SELECT count(*) AS count FROM ${table} WHERE org_id = ?`,
          )
          .get(orgA.id)?.count,
      ).toBe(0);
      expect(
        tenantDb
          .query<{ count: number }, [string]>(
            `SELECT count(*) AS count FROM ${table} WHERE org_id = ?`,
          )
          .get(orgB.id)?.count,
      ).toBe(1);
    }
    expect(
      tenantDb
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM project WHERE org_id = ?",
        )
        .get(orgA.id)?.count,
    ).toBe(1);
    expect(
      authDb
        .query(
          "SELECT * FROM organization_deletion_receipt WHERE org_id = ?",
        )
        .get(orgA.id),
    ).toEqual({
      org_id: orgA.id,
      actor_user_id: ownerA.id,
      request_id: "request-schedule",
      scheduled_at: NOW.toISOString(),
      purge_after: deadline.toISOString(),
      purged_at: deadline.toISOString(),
      outcome: "succeeded",
    });
    expect(purgeDueOrganizations(authDb, tenantDb, () => deadline)).toEqual(
      [],
    );
  });

  test("a purge interrupted after claiming resumes idempotently", async () => {
    const { authDb, orgA, ownerA } = await world();
    scheduleOrganizationDeletion(
      authDb,
      scheduleInput(orgA.id, ownerA.id),
      () => "resume-me",
      () => NOW,
    );
    const deadline = new Date(
      NOW.valueOf() + ORGANIZATION_DELETION_GRACE_DAYS * 86_400_000,
    );
    const brokenTenantDb = new Database(":memory:");
    const failed = purgeDueOrganizations(
      authDb,
      brokenTenantDb,
      () => deadline,
    );
    expect(failed[0]).toMatchObject({ orgId: orgA.id, status: "failed" });
    expect(readOrganizationLifecycle(authDb, orgA.id)?.deletion?.status).toBe(
      "purging",
    );

    expect(
      purgeDueOrganizations(authDb, createTenantDb(":memory:"), () => deadline),
    ).toEqual([{ orgId: orgA.id, status: "purged" }]);
  });
});
