import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { OPERATOR_ROOT_PATH } from "../operator/paths";
import { createWeb } from ".";
import type { WebEncoding } from "./compression";
import type { OperatorDashboardOptions } from "./operator";
import { assertTransferBudget, measureFirstLoad } from "./transfer-budget";

const encodings: WebEncoding[] = ["br", "zstd", "gzip", "deflate"];

const operator: OperatorDashboardOptions = {
  origin: "https://mimir.local",
  readSettings: () => ({
    instanceName: "Mimir",
    supportUrl: "",
    systemPrompt: null,
    operatorMcpCredentialConfigured: false,
    updatedAt: "2026-07-18T00:00:00.000Z",
  }),
  listGrants: () => [],
  listAudit: () => [],
  readHealth: () => ({
    version: "0.0.0-test",
    tenantStore: "ok",
    userCount: 1,
    organizationCount: 1,
    operatorCount: 1,
  }),
  updateSetting: () => "updated",
  replaceCredential: () => "updated",
  grant: () => "created",
  revoke: () => "revoked",
  provision: () => "created",
};

const createOperatorWeb = () => {
  const app = new Hono<IdentityEnv>();
  app.use("*", (c, next) => {
    c.set("operatorIdentity", {
      userId: "operator-1",
      authenticatedAt: Date.now(),
    });
    return next();
  });
  app.route("/", createWeb({ operator }));
  return app;
};

describe("operator transfer budget", () => {
  test("keeps the zero-runtime operator shell inside the hard gate", async () => {
    const app = createOperatorWeb();
    const fetcher = (path: string, init?: RequestInit) =>
      app.request(path, init);
    const identity = await measureFirstLoad(
      fetcher,
      OPERATOR_ROOT_PATH,
      "identity",
    );
    const compressed = await Promise.all(
      encodings.map((encoding) =>
        measureFirstLoad(fetcher, OPERATOR_ROOT_PATH, encoding),
      ),
    );

    expect(identity.requestCount).toBe(1);
    expect(identity.bytesByKind.javascript).toBe(0);
    expect(identity.externalResources).toEqual([]);
    for (const report of compressed) {
      assertTransferBudget(report);
      expect(report.requestCount).toBe(1);
      expect(report.bytesByKind.javascript).toBe(0);
      expect(report.totalBytes).toBeLessThan(identity.totalBytes);
    }
  });
});
