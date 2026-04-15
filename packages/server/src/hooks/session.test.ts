import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionContext, SessionStore } from "./session";
import { createSessionStore } from "./session";

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    project: "/test/project",
    rules: null,
    indexStatus: "10 files indexed for /test/project.",
    resolvedAt: Date.now(),
    ...overrides,
  };
}

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = createSessionStore();
  });

  test("set and get round-trips", () => {
    const ctx = makeCtx();
    store.set("fp-1", ctx);
    expect(store.get("fp-1")).toEqual(ctx);
  });

  test("get returns null for unknown fingerprint", () => {
    expect(store.get("unknown")).toBeNull();
  });

  test("has returns true after set", () => {
    store.set("fp-1", makeCtx());
    expect(store.has("fp-1")).toBe(true);
  });

  test("has returns false for unknown fingerprint", () => {
    expect(store.has("unknown")).toBe(false);
  });

  test("delete removes a session", () => {
    store.set("fp-1", makeCtx());
    store.delete("fp-1");
    expect(store.has("fp-1")).toBe(false);
    expect(store.get("fp-1")).toBeNull();
  });

  test("size tracks stored sessions", () => {
    expect(store.size).toBe(0);
    store.set("fp-1", makeCtx());
    store.set("fp-2", makeCtx());
    expect(store.size).toBe(2);
  });

  test("prune removes sessions older than maxAge", () => {
    const old = makeCtx({ resolvedAt: Date.now() - 2 * 60 * 60 * 1000 });
    const fresh = makeCtx({ resolvedAt: Date.now() });
    store.set("old-fp", old);
    store.set("fresh-fp", fresh);

    const pruned = store.prune(60 * 60 * 1000); // 1h max age
    expect(pruned).toBe(1);
    expect(store.has("old-fp")).toBe(false);
    expect(store.has("fresh-fp")).toBe(true);
  });

  test("prune returns 0 when nothing to prune", () => {
    store.set("fp-1", makeCtx());
    expect(store.prune(60 * 60 * 1000)).toBe(0);
  });

  test("set overwrites existing session", () => {
    store.set("fp-1", makeCtx({ project: "/old" }));
    store.set("fp-1", makeCtx({ project: "/new" }));
    expect(store.get("fp-1")?.project).toBe("/new");
    expect(store.size).toBe(1);
  });
});
