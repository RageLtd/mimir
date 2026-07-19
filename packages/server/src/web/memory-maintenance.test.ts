import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppendOrganizationAuditEvent } from "../audit/store";
import type { IdentityEnv } from "../middleware/identity";
import {
  createMemoryMaintenanceAction,
  type OrganizationMemoryMaintenanceOptions,
} from "./memory-maintenance";

const envelope = (id: string) => ({
  id,
  tombstone: false,
  payload: "ciphertext",
});

function fixture(
  pushResult: { accepted: number; stale: string[] } = {
    accepted: 2,
    stale: [],
  },
) {
  const audits: AppendOrganizationAuditEvent[] = [];
  const pushes: unknown[][] = [];
  const options: OrganizationMemoryMaintenanceOptions = {
    origin: "https://mimir.test",
    push: (envelopes) => {
      pushes.push(envelopes);
      return Promise.resolve(Response.json(pushResult));
    },
    audit: (event) => audits.push(event),
    id: () => "generated-1",
  };
  const app = new Hono<IdentityEnv>();
  app.use("*", (c, next) => {
    c.set("identity", {
      userId: "user-1",
      orgId: "org-1",
      organizationRoles: ["owner"],
    });
    return next();
  });
  app.post(
    "/admin/memories/maintenance",
    createMemoryMaintenanceAction(options),
  );
  return { app, audits, pushes };
}

const request = (
  app: Hono<IdentityEnv>,
  body: unknown,
  origin = "https://mimir.test",
) =>
  app.request("/admin/memories/maintenance", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

describe("organization memory maintenance action", () => {
  test("pushes opaque envelopes through the canonical path and audits bounded counts", async () => {
    const { app, audits, pushes } = fixture();
    const response = await request(app, {
      envelopes: [envelope("memory:one"), envelope("memory:two")],
    });

    expect(response.status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(audits).toHaveLength(2);
    expect(audits.map((event) => event.outcome)).toEqual([
      "intent",
      "succeeded",
    ]);
    expect(audits[1]).toMatchObject({
      orgId: "org-1",
      actorUserId: "user-1",
      action: "memory.maintenance",
      targetType: "memory-set",
      targetId: "memory-set:generated-1",
      metadata: { count: 2 },
    });
    expect(JSON.stringify(audits)).not.toContain("ciphertext");
  });

  test("uses a bounded opaque envelope id only for a single-record target", async () => {
    const { app, audits } = fixture({ accepted: 1, stale: [] });
    await request(app, { envelopes: [envelope("memory:one")] });
    expect(audits[1]?.targetId).toBe("memory:one");
  });

  test("records a conflict without exposing stale identifiers in audit metadata", async () => {
    const { app, audits } = fixture({ accepted: 1, stale: ["memory:two"] });
    const response = await request(app, {
      envelopes: [envelope("memory:one"), envelope("memory:two")],
    });
    expect(response.status).toBe(200);
    expect(audits[1]).toMatchObject({
      outcome: "failed",
      metadata: { count: 2, reasonCode: "conflict" },
    });
    expect(JSON.stringify(audits)).not.toContain("memory:two");
  });

  test("rejects untrusted origins and malformed batches before side effects", async () => {
    const { app, audits, pushes } = fixture();
    expect(
      (
        await request(
          app,
          { envelopes: [envelope("memory:one")] },
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
    expect((await request(app, { envelopes: [] })).status).toBe(400);
    expect(audits).toEqual([]);
    expect(pushes).toEqual([]);
  });
});
