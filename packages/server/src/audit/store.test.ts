import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createOrganizationAuditStore,
  DEFAULT_AUDIT_RETENTION_DAYS,
  migrateOrganizationAudit,
  type OrganizationAuditAction,
  type OrganizationAuditOutcome,
  type OrganizationAuditTarget,
} from "./store";

function auditDb() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE organization (id TEXT PRIMARY KEY) STRICT");
  db.run("INSERT INTO organization (id) VALUES ('org-a'), ('org-b')");
  migrateOrganizationAudit(db);
  return db;
}

function fixtureStore(db: Database) {
  let sequence = 0;
  return createOrganizationAuditStore(
    db,
    () => `event-${++sequence}`,
    () => new Date(Date.UTC(2026, 0, sequence, 12)),
  );
}

const event = (orgId: string, targetId: string) => {
  const action: OrganizationAuditAction = "invitation.created";
  const targetType: OrganizationAuditTarget = "invitation";
  const outcome: OrganizationAuditOutcome = "succeeded";
  return {
    orgId,
    actorUserId: "user-1",
    action,
    targetType,
    targetId,
    outcome,
    requestId: `request-${targetId}`,
  };
};

describe("organization audit store", () => {
  test("migration is idempotent and defines the conservative retention default", () => {
    const db = auditDb();
    migrateOrganizationAudit(db);
    const row: unknown = db
      .query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'organization_audit_policy'",
      )
      .get();

    expect(row).toBeObject();
    expect(JSON.stringify(row)).toContain(String(DEFAULT_AUDIT_RETENTION_DAYS));
  });

  test("appends bounded events and lists only the requested organization", () => {
    const db = auditDb();
    const store = fixtureStore(db);
    store.append({
      ...event("org-a", "invite-1"),
      metadata: { count: 1, reasonCode: "validation" },
    });
    store.append({
      ...event("org-b", "invite-2"),
      outcome: "failed",
      metadata: { reasonCode: "conflict" },
    });

    const result = store.list("org-a");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: "event-1",
      actorUserId: "user-1",
      targetId: "invite-1",
      outcome: "succeeded",
      metadata: { count: 1, reasonCode: "validation" },
    });
    expect(JSON.stringify(result)).not.toContain("invite-2");
    expect(result.retentionDays).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  test("default event ids remain callable under Bun's Crypto receiver rules", () => {
    const store = createOrganizationAuditStore(auditDb());
    const appended = store.append(event("org-a", "invite-default-id"));

    expect(appended.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("supports bounded filters and cursor pagination", () => {
    const store = fixtureStore(auditDb());
    store.append(event("org-a", "invite-1"));
    store.append({
      ...event("org-a", "member-1"),
      action: "membership.role_changed",
      targetType: "member",
      metadata: { fromRole: "member", toRole: "admin" },
    });
    store.append({
      ...event("org-a", "member-2"),
      action: "membership.removed",
      targetType: "member",
      outcome: "failed",
      actorUserId: "user-2",
      metadata: { reasonCode: "conflict" },
    });

    const first = store.list("org-a", { limit: 2 });
    expect(first.events.map((item) => item.targetId)).toEqual([
      "member-2",
      "member-1",
    ]);
    expect(first.nextCursor).not.toBeNull();
    expect(
      store
        .list("org-a", { limit: 2, cursor: first.nextCursor ?? undefined })
        .events.map((item) => item.targetId),
    ).toEqual(["invite-1"]);
    expect(
      store.list("org-a", {
        targetType: "member",
        outcome: "failed",
        actorUserId: "user-2",
        fromDate: "2026-01-02",
      }).events,
    ).toHaveLength(1);
  });

  test("drops unrecognized metadata instead of persisting arbitrary values", () => {
    const db = auditDb();
    const store = fixtureStore(db);
    const metadata = {
      count: 3,
      secret: "never-store-this-password",
      wrappedKey: "never-store-this-wrap",
    };
    store.append({ ...event("org-a", "memory-set-1"), metadata });
    const row: unknown = db
      .query("SELECT metadata_json FROM organization_audit_event")
      .get();

    expect(row).toEqual({ metadata_json: '{"count":3}' });
    expect(JSON.stringify(store.list("org-a"))).not.toContain("never-store");
  });

  test("keeps only schema-valid before and after setting values", () => {
    const db = auditDb();
    const store = fixtureStore(db);
    store.append({
      ...event("org-a", "org-a"),
      action: "organization.settings_changed",
      targetType: "organization",
      metadata: {
        field: "slug",
        fromValue: "before-org",
        toValue: "after-org",
      },
    });
    store.append({
      ...event("org-a", "org-a"),
      action: "organization.settings_changed",
      targetType: "organization",
      metadata: {
        field: "slug",
        fromValue: "../../secret",
        toValue: "also invalid",
      },
    });

    expect(store.list("org-a").events[1]?.metadata).toEqual({
      field: "slug",
      fromValue: "before-org",
      toValue: "after-org",
    });
    expect(store.list("org-a").events[0]?.metadata).toEqual({ field: "slug" });
  });

  test("rejects identifiers that could smuggle emails, tokens, or paths", () => {
    const store = fixtureStore(auditDb());
    expect(() =>
      store.append({ ...event("org-a", "person@example.test") }),
    ).toThrow(/opaque id/);
    expect(() =>
      store.append({ ...event("org-a", "invite-1"), requestId: "../secret" }),
    ).toThrow(/opaque id/);
    expect(() => store.list("org-a", { cursor: "%%%" })).toThrow(
      /invalid audit cursor/,
    );
    expect(() => store.list("org-a", { fromDate: "2026-99-99" })).toThrow(
      /invalid audit date/,
    );
  });

  test("retention pruning is organization-scoped and not exposed as a mutation API", () => {
    const db = auditDb();
    let oldSequence = 0;
    const old = createOrganizationAuditStore(
      db,
      () => `event-old-${++oldSequence}`,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    old.append(event("org-a", "invite-old"));
    old.append({ ...event("org-b", "invite-other"), targetId: "invite-other" });
    db.run(
      "INSERT INTO organization_audit_policy (org_id, retention_days) VALUES ('org-a', 30)",
    );
    const current = createOrganizationAuditStore(
      db,
      () => "event-current",
      () => new Date("2026-02-15T00:00:00.000Z"),
    );
    current.append(event("org-a", "invite-current"));

    expect(current.list("org-a").events.map((item) => item.targetId)).toEqual([
      "invite-current",
    ]);
    expect(current.list("org-b").events.map((item) => item.targetId)).toEqual([
      "invite-other",
    ]);
    expect(Object.keys(current).sort()).toEqual(["append", "list"]);
  });

  test("retention also hides expired records when no later event triggers pruning", () => {
    const db = auditDb();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const store = createOrganizationAuditStore(
      db,
      () => "event-expiring",
      () => clock,
    );
    store.append(event("org-a", "invite-expiring"));
    db.run(
      "INSERT INTO organization_audit_policy (org_id, retention_days) VALUES ('org-a', 30)",
    );
    clock = new Date("2026-02-15T00:00:00.000Z");

    expect(store.list("org-a").events).toEqual([]);
  });
});
