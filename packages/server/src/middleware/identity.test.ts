/**
 * MIM-70 slice 2: identity gate — credential header mapping and gating
 * behavior with an injected session lookup (never touches the config-driven
 * singleton or the filesystem).
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createIdentityGate,
  type IdentityEnv,
  pickSoleOrg,
  readIdentity,
  scopeOrgId,
  toAuthHeaders,
} from "./identity";

describe("toAuthHeaders", () => {
  test("maps Authorization Bearer onto x-api-key", () => {
    const h = toAuthHeaders({ authorization: "Bearer sk-mimir-123" });
    expect(h.get("x-api-key")).toBe("sk-mimir-123");
  });

  test("explicit x-api-key wins over Authorization", () => {
    const h = toAuthHeaders({
      authorization: "Bearer from-bearer",
      apiKey: "from-header",
    });
    expect(h.get("x-api-key")).toBe("from-header");
  });

  test("cookies pass through untouched", () => {
    const h = toAuthHeaders({ cookie: "better-auth.session_token=abc" });
    expect(h.get("cookie")).toBe("better-auth.session_token=abc");
    expect(h.get("x-api-key")).toBeNull();
  });

  test("non-Bearer Authorization is ignored", () => {
    const h = toAuthHeaders({ authorization: "Basic dXNlcjpwYXNz" });
    expect(h.get("x-api-key")).toBeNull();
  });
});

/** Default org lister returns none — only the sole-membership tests inject a
 *  list, and any session carrying an active org never calls it. */
function appWithGate(
  lookup: (headers: Headers) => Promise<unknown>,
  listOrgs: (headers: Headers) => Promise<unknown> = () => Promise.resolve([]),
) {
  const app = new Hono<IdentityEnv>();
  app.use("*", createIdentityGate(lookup, listOrgs));
  app.get("/health", (c) => c.json({ ok: true }));
  // Echo the resolved org so tests can assert the gate's scoping decision.
  app.get("/v1/protected", (c) => c.json({ ok: true, org: scopeOrgId(c) }));
  app.post("/api/auth/sign-in/email", (c) => c.json({ auth: true }));
  return app;
}

describe("readIdentity", () => {
  test("extracts userId + active org", () => {
    expect(
      readIdentity({ user: { id: "u1" }, session: { activeOrganizationId: "o1" } }),
    ).toEqual({ userId: "u1", orgId: "o1" });
  });

  test("no active org → orgId null", () => {
    expect(readIdentity({ user: { id: "u1" }, session: {} })).toEqual({
      userId: "u1",
      orgId: null,
    });
  });

  test("malformed sessions → null", () => {
    expect(readIdentity(null)).toBeNull();
    expect(readIdentity({})).toBeNull();
    expect(readIdentity({ user: {} })).toBeNull();
    expect(readIdentity({ user: { id: 42 } })).toBeNull();
  });
});

describe("pickSoleOrg", () => {
  test("one org → its id", () => {
    expect(pickSoleOrg([{ id: "only" }])).toBe("only");
  });
  test("zero or many → null", () => {
    expect(pickSoleOrg([])).toBeNull();
    expect(pickSoleOrg([{ id: "a" }, { id: "b" }])).toBeNull();
    expect(pickSoleOrg("nope")).toBeNull();
  });
});

describe("createIdentityGate", () => {
  const denyAll = () => Promise.resolve(null);
  const allowWithOrg = () =>
    Promise.resolve({ user: { id: "u1" }, session: { activeOrganizationId: "org-1" } });

  test("credential-less request to a gated route is a detail-free 401", async () => {
    const res = await appWithGate(denyAll).request("/v1/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "Unauthorized" } });
  });

  test("valid session passes through and scopes to the active org", async () => {
    const res = await appWithGate(allowWithOrg).request("/v1/protected", {
      headers: { authorization: "Bearer valid-key" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, org: "org-1" });
  });

  test("no active org falls back to a sole membership", async () => {
    const res = await appWithGate(
      () => Promise.resolve({ user: { id: "u1" }, session: {} }),
      () => Promise.resolve([{ id: "sole-org" }]),
    ).request("/v1/protected", { headers: { authorization: "Bearer k" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, org: "sole-org" });
  });

  test("no active org and no sole membership → detail-free 403", async () => {
    const res = await appWithGate(
      () => Promise.resolve({ user: { id: "u1" }, session: {} }),
      () => Promise.resolve([{ id: "a" }, { id: "b" }]),
    ).request("/v1/protected", { headers: { authorization: "Bearer k" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: "Forbidden" } });
  });

  test("lookup rejection is the same detail-free 401", async () => {
    const res = await appWithGate(() =>
      Promise.reject(new Error("invalid key")),
    ).request("/v1/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "Unauthorized" } });
  });

  test("/health is exempt", async () => {
    const res = await appWithGate(denyAll).request("/health");
    expect(res.status).toBe(200);
  });

  test("/health/ and case variants stay gated (conservative exemption)", async () => {
    expect((await appWithGate(denyAll).request("/health/")).status).toBe(401);
    expect((await appWithGate(denyAll).request("/HEALTH")).status).toBe(401);
  });

  test("/api/auth/* is exempt — better-auth self-gates", async () => {
    const res = await appWithGate(denyAll).request("/api/auth/sign-in/email", {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("the gate consults the lookup with mapped headers", async () => {
    let seen: Headers | null = null;
    const app = appWithGate((headers) => {
      seen = headers;
      return Promise.resolve({
        user: { id: "u1" },
        session: { activeOrganizationId: "org-1" },
      });
    });
    await app.request("/v1/protected", {
      headers: { authorization: "Bearer the-key" },
    });
    expect(seen).not.toBeNull();
    expect((seen as unknown as Headers).get("x-api-key")).toBe("the-key");
  });
});
