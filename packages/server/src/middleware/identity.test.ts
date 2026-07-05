/**
 * MIM-70 slice 2: identity gate — credential header mapping and gating
 * behavior with an injected session lookup (never touches the config-driven
 * singleton or the filesystem).
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createIdentityGate, toAuthHeaders } from "./identity";

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

function appWithGate(lookup: (headers: Headers) => Promise<unknown>) {
  const app = new Hono();
  app.use("*", createIdentityGate(lookup));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/protected", (c) => c.json({ ok: true }));
  app.post("/api/auth/sign-in/email", (c) => c.json({ auth: true }));
  return app;
}

describe("createIdentityGate", () => {
  const denyAll = () => Promise.resolve(null);
  const allowAll = () => Promise.resolve({ user: { id: "u1" } });

  test("credential-less request to a gated route is a detail-free 401", async () => {
    const res = await appWithGate(denyAll).request("/v1/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "Unauthorized" } });
  });

  test("valid session passes through", async () => {
    const res = await appWithGate(allowAll).request("/v1/protected", {
      headers: { authorization: "Bearer valid-key" },
    });
    expect(res.status).toBe(200);
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
      return Promise.resolve({ user: { id: "u1" } });
    });
    await app.request("/v1/protected", {
      headers: { authorization: "Bearer the-key" },
    });
    expect(seen).not.toBeNull();
    expect((seen as unknown as Headers).get("x-api-key")).toBe("the-key");
  });
});
