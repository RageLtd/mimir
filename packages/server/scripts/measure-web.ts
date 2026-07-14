import { Hono } from "hono";
import type { IdentityEnv } from "../src/middleware/identity";
import { createWeb, web } from "../src/web";
import type { WebEncoding } from "../src/web/compression";
import {
  assertTransferBudget,
  COLD_LOAD_BUDGET_BYTES,
  MINIMUM_PUBLIC_HTTP_VERSION,
  measureFirstLoad,
  SINGLE_PACKET_PAYLOAD_TARGET_BYTES,
} from "../src/web/transfer-budget";

const fetcher = (path: string, init?: RequestInit) => web.request(path, init);
const adminWeb = createWeb({ organizationAdmin: true });
const adminFetcher = (path: string, init?: RequestInit) =>
  adminWeb.request(path, init);
const activityWeb = new Hono<IdentityEnv>();
activityWeb.use("*", (c, next) => {
  c.set("identity", {
    userId: "user-1",
    orgId: "org-1",
    organizationRoles: ["owner"],
  });
  return next();
});
activityWeb.route(
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
const activityFetcher = (path: string, init?: RequestInit) =>
  activityWeb.request(path, init);
const credentialWeb = createWeb({
  credentials: {
    origin: "https://mimir.local",
    request: (path) => {
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
    },
  },
});
const credentialFetcher = (path: string, init?: RequestInit) =>
  credentialWeb.request(path, init);
const memberWeb = new Hono<IdentityEnv>();
memberWeb.use("*", (c, next) => {
  c.set("identity", {
    userId: "user-1",
    orgId: "org-1",
    organizationRoles: ["owner"],
  });
  return next();
});
memberWeb.route(
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
const memberFetcher = (path: string, init?: RequestInit) =>
  memberWeb.request(path, init);
const settingsWeb = new Hono<IdentityEnv>();
settingsWeb.use("*", (c, next) => {
  c.set("identity", {
    userId: "user-1",
    orgId: "org-1",
    organizationRoles: ["owner"],
  });
  return next();
});
settingsWeb.route(
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
const settingsFetcher = (path: string, init?: RequestInit) =>
  settingsWeb.request(path, init);
const adminMemoryWeb = new Hono<IdentityEnv>();
adminMemoryWeb.use("*", (c, next) => {
  c.set("identity", {
    userId: "user-1",
    orgId: "org-1",
    organizationRoles: ["owner"],
  });
  return next();
});
adminMemoryWeb.route(
  "/",
  createWeb({
    organizationAdmin: true,
    organizationMemoryMaintenance: {
      origin: "https://mimir.local",
      push: () => Promise.resolve(Response.json({ accepted: 1, stale: [] })),
      audit: () => undefined,
    },
  }),
);
const adminMemoryFetcher = (path: string, init?: RequestInit) =>
  adminMemoryWeb.request(path, init);
const encodings: WebEncoding[] = ["identity", "br", "zstd", "gzip", "deflate"];
const reports = [];
for (const route of ["/sign-in", "/sign-up", "/app"]) {
  for (const encoding of encodings) {
    reports.push(await measureFirstLoad(fetcher, route, encoding));
  }
}
for (const encoding of encodings) {
  reports.push(await measureFirstLoad(adminFetcher, "/admin", encoding));
  reports.push(
    await measureFirstLoad(activityFetcher, "/admin/activity", encoding),
  );
  reports.push(
    await measureFirstLoad(credentialFetcher, "/app/credentials", encoding),
  );
  reports.push(
    await measureFirstLoad(memberFetcher, "/admin/members", encoding),
  );
  reports.push(
    await measureFirstLoad(settingsFetcher, "/admin/settings", encoding),
  );
  reports.push(
    await measureFirstLoad(adminMemoryFetcher, "/admin/memories", encoding),
  );
  reports.push(await measureFirstLoad(fetcher, "/app/memories", encoding));
}

for (const report of reports) assertTransferBudget(report);

process.stdout.write(
  `${JSON.stringify(
    {
      budgets: {
        minimumPublicHttpVersion: MINIMUM_PUBLIC_HTTP_VERSION,
        singlePacketPayloadTargetBytes: SINGLE_PACKET_PAYLOAD_TARGET_BYTES,
        coldLoadHardLimitBytes: COLD_LOAD_BUDGET_BYTES,
      },
      reports,
    },
    null,
    2,
  )}\n`,
);
