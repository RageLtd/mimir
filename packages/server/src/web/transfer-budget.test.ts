import { describe, expect, test } from "bun:test";
import { type Env, Hono } from "hono";
import { createWeb, web } from ".";
import type { IdentityEnv } from "../middleware/identity";
import type { WebEncoding } from "./compression";
import { buildIsland } from "./islands";
import {
  assertTransferBudget,
  COLD_LOAD_BUDGET_BYTES,
  discoverCriticalResources,
  measureFirstLoad,
} from "./transfer-budget";

const fetchWith = <E extends Env>(app: Hono<E>) =>
  (path: string, init?: RequestInit) =>
    app.request(path, init);
const compressedEncodings: WebEncoding[] = ["br", "zstd", "gzip", "deflate"];

const createActivityWeb = () => {
  const app = new Hono<IdentityEnv>();
  app.use("*", (c, next) => {
    c.set("identity", {
      userId: "user-1",
      orgId: "org-1",
      organizationRoles: ["owner"],
    });
    return next();
  });
  app.route(
    "/",
    createWeb({
      organizationAdmin: true,
      organizationAuditList: () => ({
        events: [
          {
            id: "event-1",
            actorUserId: "user-1",
            action: "membership.role_changed",
            targetType: "member",
            targetId: "member-2",
            outcome: "succeeded",
            requestId: "request-1",
            metadata: { fromRole: "member", toRole: "admin" },
            createdAt: "2026-07-13T00:00:00.000Z",
            cursor: "MQ",
          },
        ],
        nextCursor: null,
        retentionDays: 365,
      }),
    }),
  );
  return app;
};

const createMemberWeb = () => {
  const app = new Hono<IdentityEnv>();
  app.use("*", (c, next) => {
    c.set("identity", {
      userId: "user-1",
      orgId: "org-1",
      organizationRoles: ["owner"],
    });
    return next();
  });
  app.route(
    "/",
    createWeb({
      organizationAdmin: true,
      organizationMembers: {
        origin: "https://mimir.local",
        list: () => ({
          keyGeneration: 1,
          defaultInvitationRole: "member",
          members: [
            {
              id: "member-1",
              userId: "user-1",
              name: "Owner",
              email: "owner@example.test",
              role: "owner",
              joinedAt: "2026-07-13T00:00:00.000Z",
              publicKeyRegistered: true,
              wrapAvailable: true,
              readiness: "ready",
            },
            {
              id: "member-2",
              userId: "user-2",
              name: "Member",
              email: "member@example.test",
              role: "member",
              joinedAt: "2026-07-14T00:00:00.000Z",
              publicKeyRegistered: true,
              wrapAvailable: false,
              readiness: "pending",
            },
          ],
          invitations: [],
          nextMemberCursor: null,
          nextInvitationCursor: null,
        }),
        invite: () => Promise.resolve("created"),
        revokeInvitation: () => Promise.resolve("revoked"),
        reissueInvitation: () => Promise.resolve("reissued"),
        request: () => Response.json({ ok: true }),
      },
    }),
  );
  return app;
};

const createSettingsWeb = () => {
  const app = new Hono<IdentityEnv>();
  app.use("*", (c, next) => {
    c.set("identity", {
      userId: "user-1",
      orgId: "org-1",
      organizationRoles: ["owner"],
    });
    return next();
  });
  app.route(
    "/",
    createWeb({
      organizationAdmin: true,
      organizationSettings: {
        origin: "https://mimir.local",
        read: () => ({
          id: "org-1",
          name: "Mimir Testers",
          slug: "mimir-testers",
          defaultInvitationRole: "member",
          invitationLifetimeDays: 2,
          auditRetentionDays: 365,
          policyVersion: 0,
          keyGeneration: 1,
          recoveryReady: true,
        }),
        updateName: () => Promise.resolve("updated"),
        updateSlug: () => Promise.resolve("updated"),
        updatePolicy: () => "updated",
      },
    }),
  );
  return app;
};

describe("critical resource discovery", () => {
  test("finds same-origin initial assets and rejects third-party paths", () => {
    const found = discoverCriticalResources(
      `<!doctype html>
        <link rel="stylesheet" href="/app.css">
        <link rel="modulepreload" href="/module.js">
        <link rel="preload" as="font" href="/mimir.woff2">
        <script src="/app.js"></script>
        <img src="/hero.png" srcset="/hero@2x.png 2x">
        <img loading="lazy" src="/below-fold.png">
        <script src="https://example.com/tracker.js"></script>`,
      "/",
    );

    expect(found.resources).toEqual([
      { path: "/app.css", kind: "css" },
      { path: "/module.js", kind: "javascript" },
      { path: "/mimir.woff2", kind: "font" },
      { path: "/app.js", kind: "javascript" },
      { path: "/hero.png", kind: "image" },
      { path: "/hero@2x.png", kind: "image" },
    ]);
    expect(found.externalResources).toEqual([
      "https://example.com/tracker.js",
    ]);
  });
});

describe("first-load measurement", () => {
  test("enforces the current SSR route under identity and gzip", async () => {
    const fetcher = fetchWith(createWeb({ organizationAdmin: true }));
    for (const route of ["/sign-in", "/sign-up", "/app", "/admin"]) {
      const identity = await measureFirstLoad(fetcher, route, "identity");
      const compressed = await Promise.all(
        compressedEncodings.map((encoding) =>
          measureFirstLoad(fetcher, route, encoding),
        ),
      );

      assertTransferBudget(identity);
      expect(identity.requestCount).toBe(1);
      expect(identity.bytesByKind.javascript).toBe(0);
      expect(identity.entries[0]?.servedEncoding).toBe("identity");
      expect(identity.budgetEnforced).toBe(false);
      expect(identity.hardLimitMet).toBeNull();
      for (const report of compressed) {
        assertTransferBudget(report);
        expect(report.entries[0]?.servedEncoding).toBe(
          report.requestedEncoding,
        );
        expect(report.totalBytes).toBeLessThan(identity.totalBytes);
        expect(report.protocol).toBe("h2");
      }
    }
  });

  test("organization activity stays server-rendered and inside the hard gate", async () => {
    const fetcher = fetchWith(createActivityWeb());
    const identity = await measureFirstLoad(
      fetcher,
      "/admin/activity",
      "identity",
    );
    const compressed = await Promise.all(
      compressedEncodings.map((encoding) =>
        measureFirstLoad(fetcher, "/admin/activity", encoding),
      ),
    );

    assertTransferBudget(identity);
    expect(identity.requestCount).toBe(1);
    expect(identity.bytesByKind.javascript).toBe(0);
    for (const report of compressed) {
      assertTransferBudget(report);
      expect(report.totalBytes).toBeLessThan(identity.totalBytes);
      expect(report.protocol).toBe("h2");
    }
  });

  test("credential island is route-scoped, dependency-free, and inside the hard gate", async () => {
    const request = (path: string) => {
      if (path === "/api/auth/get-session") {
        return Response.json({ session: { id: "session-1" } });
      }
      if (path === "/api/auth/list-sessions") return Response.json([]);
      if (path === "/api/auth/api-key/list") {
        return Response.json({ apiKeys: [], total: 0 });
      }
      if (path === "/api/auth/passkey/list-user-passkeys") {
        return Response.json([]);
      }
      return Response.json({
        keyGeneration: null,
        self: {
          publicKey: null,
          encryptedKeyset: null,
          wrappedOrgKey: null,
        },
      });
    };
    const credentialWeb = createWeb({
      credentials: { origin: "https://mimir.local", request },
    });
    const fetcher = fetchWith(credentialWeb);
    const identity = await measureFirstLoad(
      fetcher,
      "/app/credentials",
      "identity",
    );
    const gzip = await measureFirstLoad(
      fetcher,
      "/app/credentials",
      "gzip",
    );
    const bundle = await buildIsland("credentials");

    assertTransferBudget(identity);
    assertTransferBudget(gzip);
    expect(identity.requestCount).toBe(2);
    expect(identity.bytesByKind.javascript).toBeGreaterThan(0);
    expect(gzip.totalBytes).toBeLessThan(identity.totalBytes);
    expect(bundle).toContain('customElements.define("mimir-credential-ceremony"');
    expect(bundle).not.toContain("from\"");
    expect(bundle).not.toContain("node:");
    expect(bundle).not.toContain("playwright");
    expect(bundle).not.toContain("generate-authenticate-options");
    expect(bundle).not.toContain("verify-authentication");
  });

  test("member island is route-scoped, runtime-free, and inside the hard gate", async () => {
    const fetcher = fetchWith(createMemberWeb());
    const identity = await measureFirstLoad(
      fetcher,
      "/admin/members",
      "identity",
    );
    const compressed = await Promise.all(
      compressedEncodings.map((encoding) =>
        measureFirstLoad(fetcher, "/admin/members", encoding),
      ),
    );
    const bundle = await buildIsland("members");

    assertTransferBudget(identity);
    expect(identity.requestCount).toBe(2);
    expect(identity.bytesByKind.javascript).toBeGreaterThan(0);
    expect(bundle).toContain(
      'customElements.define("mimir-member-key-manager"',
    );
    expect(bundle).not.toContain("from\"");
    expect(bundle).not.toContain("node:");
    expect(bundle).not.toContain("playwright");
    expect(bundle).not.toContain("generate-authenticate-options");
    expect(bundle).not.toContain("verify-authentication");
    for (const report of compressed) {
      assertTransferBudget(report);
      expect(report.totalBytes).toBeLessThan(identity.totalBytes);
      expect(report.protocol).toBe("h2");
    }
  });

  test("organization settings stays server-rendered and inside the hard gate", async () => {
    const fetcher = fetchWith(createSettingsWeb());
    const identity = await measureFirstLoad(
      fetcher,
      "/admin/settings",
      "identity",
    );
    const compressed = await Promise.all(
      compressedEncodings.map((encoding) =>
        measureFirstLoad(fetcher, "/admin/settings", encoding),
      ),
    );

    assertTransferBudget(identity);
    expect(identity.requestCount).toBe(1);
    expect(identity.bytesByKind.javascript).toBe(0);
    for (const report of compressed) {
      assertTransferBudget(report);
      expect(report.totalBytes).toBeLessThan(identity.totalBytes);
      expect(report.protocol).toBe("h2");
    }
  });

  test("memory island is route-scoped, dependency-free, and inside the hard gate", async () => {
    const fetcher = fetchWith(web);
    const identity = await measureFirstLoad(
      fetcher,
      "/app/memories",
      "identity",
    );
    const compressed = await Promise.all(
      compressedEncodings.map((encoding) =>
        measureFirstLoad(fetcher, "/app/memories", encoding),
      ),
    );
    const bundle = await buildIsland("memories");

    assertTransferBudget(identity);
    expect(identity.requestCount).toBe(2);
    expect(identity.bytesByKind.javascript).toBeGreaterThan(0);
    expect(bundle).toContain('customElements.define("mimir-memory-manager"');
    expect(bundle).not.toContain("from\"");
    expect(bundle).not.toContain("node:");
    for (const report of compressed) {
      assertTransferBudget(report);
      expect(report.totalBytes).toBeLessThan(identity.totalBytes);
    }
  });

  test("counts every referenced critical asset", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      c.html(
        '<link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
      ),
    );
    app.get("/app.css", (c) => c.text("body{}", 200));
    app.get("/app.js", (c) =>
      c.body("customElements.define('m-test', class extends HTMLElement {})", {
        headers: { "content-type": "text/javascript; charset=UTF-8" },
      }),
    );

    const report = await measureFirstLoad(fetchWith(app), "/", "identity");

    expect(report.entries.map((entry) => entry.path)).toEqual([
      "/",
      "/app.css",
      "/app.js",
    ]);
    expect(report.bytesByKind.css).toBeGreaterThan(0);
    expect(report.bytesByKind.javascript).toBeGreaterThan(0);
    expect(report.requestCount).toBe(3);
  });

  test("fails deterministically above the hard limit", async () => {
    const app = new Hono();
    app.get("/", (c) => c.html("x".repeat(COLD_LOAD_BUDGET_BYTES)));

    const report = await measureFirstLoad(fetchWith(app), "/", "gzip");

    expect(report.hardLimitMet).toBe(false);
    expect(() => assertTransferBudget(report)).toThrow(
      /cold load is .* budget is/,
    );
  });

  test("identity is diagnostic rather than a deployment gate", async () => {
    const app = new Hono();
    app.get("/", (c) => c.html("x".repeat(COLD_LOAD_BUDGET_BYTES)));

    const report = await measureFirstLoad(fetchWith(app), "/", "identity");

    expect(report.withinHardLimit).toBe(false);
    expect(report.budgetEnforced).toBe(false);
    expect(report.hardLimitMet).toBeNull();
    expect(() => assertTransferBudget(report)).not.toThrow();
  });

  test("fails when the critical path leaves the origin", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      c.html('<script src="https://example.com/runtime.js"></script>'),
    );

    const report = await measureFirstLoad(fetchWith(app), "/", "identity");

    expect(report.hardLimitMet).toBeNull();
    expect(() => assertTransferBudget(report)).toThrow(/external resources/);
  });
});
