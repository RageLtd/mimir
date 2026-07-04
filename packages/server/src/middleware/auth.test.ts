import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createBearerGate, keyMatches } from "./auth";

const KEYS = ["key-alpha", "key-beta"];

const gatedApp = () => {
  const app = new Hono();
  app.use("*", createBearerGate(KEYS));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/v1/models", (c) => c.json({ data: [] }));
  return app;
};

describe("keyMatches", () => {
  test("matches any configured key", () => {
    expect(keyMatches("key-alpha", KEYS)).toBe(true);
    expect(keyMatches("key-beta", KEYS)).toBe(true);
  });

  test("rejects wrong, empty, and near-miss keys", () => {
    expect(keyMatches("key-gamma", KEYS)).toBe(false);
    expect(keyMatches("", KEYS)).toBe(false);
    expect(keyMatches("key-alpha ", KEYS)).toBe(false);
    expect(keyMatches("key-alph", KEYS)).toBe(false);
  });
});

describe("createBearerGate", () => {
  test("valid key passes", async () => {
    const res = await gatedApp().request("/v1/models", {
      headers: { Authorization: "Bearer key-beta" },
    });
    expect(res.status).toBe(200);
  });

  test("missing header → 401 with no detail", async () => {
    const res = await gatedApp().request("/v1/models");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Unauthorized" } });
  });

  test("wrong key → 401", async () => {
    const res = await gatedApp().request("/v1/models", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  test("malformed header (no Bearer prefix) → 401", async () => {
    const res = await gatedApp().request("/v1/models", {
      headers: { Authorization: "key-alpha" },
    });
    expect(res.status).toBe(401);
  });

  test("/health stays open without a key", async () => {
    const res = await gatedApp().request("/health");
    expect(res.status).toBe(200);
  });
});
