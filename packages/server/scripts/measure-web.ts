import { Hono } from "hono";
import type { IdentityEnv } from "../src/middleware/identity";
import { createWeb, web } from "../src/web";
import type { WebEncoding } from "../src/web/compression";
import {
  assertTransferBudget,
  COLD_LOAD_BUDGET_BYTES,
  MINIMUM_PUBLIC_HTTP_VERSION,
  measureFirstLoad,
  SINGLE_DATAGRAM_TARGET_BYTES,
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
  reports.push(await measureFirstLoad(fetcher, "/app/memories", encoding));
}

for (const report of reports) assertTransferBudget(report);

process.stdout.write(
  `${JSON.stringify(
    {
      budgets: {
        minimumPublicHttpVersion: MINIMUM_PUBLIC_HTTP_VERSION,
        singleDatagramTargetBytes: SINGLE_DATAGRAM_TARGET_BYTES,
        coldLoadHardLimitBytes: COLD_LOAD_BUDGET_BYTES,
      },
      reports,
    },
    null,
    2,
  )}\n`,
);
