import { describe, expect, test } from "bun:test";
import type { AppendOrganizationAuditEvent } from "../audit/store";
import { createApp } from "../app";

function fixture() {
  const audits: AppendOrganizationAuditEvent[] = [];
  const pushes: unknown[][] = [];
  const app = createApp({
    authEnabled: true,
    authHandler: async () => Response.json({}),
    claimGuard: async (_c, next) => next(),
    sessionLookup: async (headers) => {
      const cookie = headers.get("cookie");
      if (!cookie || cookie === "session=removed") return null;
      const userId = cookie === "session=member" ? "user-member" : "user-1";
      const orgId = cookie === "session=org-two" ? "org-2" : "org-1";
      return {
        user: { id: userId },
        session: { activeOrganizationId: orgId },
      };
    },
    orgLister: async () => [],
    activeMemberLookup: async (headers) => {
      const cookie = headers.get("cookie");
      if (cookie === "session=removed") return null;
      if (cookie === "session=member") {
        return {
          userId: "user-member",
          organizationId: "org-1",
          role: "member",
        };
      }
      return {
        userId: "user-1",
        organizationId: cookie === "session=org-two" ? "org-2" : "org-1",
        role: cookie === "session=admin" ? "admin" : "owner",
      };
    },
    organizationMemoryMaintenance: {
      origin: "https://mimir.test",
      push: (envelopes) => {
        pushes.push(envelopes);
        return Promise.resolve(
          Response.json({ accepted: envelopes.length, stale: [] }),
        );
      },
      audit: (event) => audits.push(event),
      id: () => "request-generated",
    },
  });
  return { app, audits, pushes };
}

const get = (app: ReturnType<typeof createApp>, cookie?: string) =>
  app.request("https://mimir.test/admin/memories", {
    headers: cookie ? { cookie } : {},
  });

const maintain = (
  app: ReturnType<typeof createApp>,
  cookie = "session=owner",
  origin = "https://mimir.test",
) =>
  app.request("https://mimir.test/admin/memories/maintenance", {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      envelopes: [{ id: "memory:one", payload: "opaque-ciphertext" }],
      orgId: "forged-org",
      actorUserId: "forged-user",
    }),
  });

describe("encrypted organization memory administration", () => {
  test("renders a content-free owner/admin shell for the active organization", async () => {
    const { app } = fixture();
    for (const cookie of ["session=owner", "session=admin"]) {
      const response = await get(app, cookie);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(body).toContain("mimir-admin-memory-manager");
      expect(body).toContain('data-user-id="user-1"');
      expect(body).toContain('data-org-id="org-1"');
      expect(body).toContain('/assets/admin-memories.js');
      expect(body).toContain("server cannot render, search, or moderate it");
      expect(body).not.toContain("private canary memory");
    }
  });

  test("organization switching re-scopes the shell without stale identity", async () => {
    const { app } = fixture();
    const body = await (await get(app, "session=org-two")).text();
    expect(body).toContain('data-org-id="org-2"');
    expect(body).not.toContain('data-org-id="org-1"');
  });

  test("trusted maintenance derives actor and org while forwarding ciphertext", async () => {
    const { app, audits, pushes } = fixture();
    const response = await maintain(app);
    expect(response.status).toBe(200);
    expect(pushes).toEqual([
      [{ id: "memory:one", payload: "opaque-ciphertext" }],
    ]);
    expect(audits[1]).toMatchObject({
      orgId: "org-1",
      actorUserId: "user-1",
      targetId: "memory:one",
      outcome: "succeeded",
      metadata: { count: 1 },
    });
    expect(JSON.stringify(audits)).not.toContain("opaque-ciphertext");
    expect(JSON.stringify(audits)).not.toContain("forged");
  });

  test("untrusted origins and non-admin identities fail before maintenance", async () => {
    const { app, audits, pushes } = fixture();
    expect((await maintain(app, "session=owner", "https://evil.test")).status).toBe(
      403,
    );
    expect((await maintain(app, "session=member")).status).toBe(403);
    expect((await maintain(app, "session=removed")).status).toBe(302);
    const apiKey = await app.request(
      "https://mimir.test/admin/memories/maintenance",
      {
        method: "POST",
        headers: {
          "x-api-key": "machine-key",
          origin: "https://mimir.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ envelopes: [{ id: "memory:one" }] }),
      },
    );
    expect(apiKey.status).toBe(403);
    expect(audits).toEqual([]);
    expect(pushes).toEqual([]);
  });

  test("signed-out and auth-off deployments never expose the admin route", async () => {
    const { app } = fixture();
    const signedOut = await get(app);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Fmemories",
    );
    expect(
      (await createApp({ authEnabled: false }).request("/admin/memories"))
        .status,
    ).toBe(404);
  });
});
