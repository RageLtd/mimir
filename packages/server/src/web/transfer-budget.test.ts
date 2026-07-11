import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { web } from ".";
import {
  assertTransferBudget,
  COLD_LOAD_BUDGET_BYTES,
  discoverCriticalResources,
  measureFirstLoad,
} from "./transfer-budget";

const fetchWith = (app: Hono) => (path: string, init?: RequestInit) =>
  app.request(path, init);

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
    const fetcher = fetchWith(web);
    const identity = await measureFirstLoad(fetcher, "/", "identity");
    const gzip = await measureFirstLoad(fetcher, "/", "gzip");

    assertTransferBudget(identity);
    assertTransferBudget(gzip);
    expect(identity.requestCount).toBe(1);
    expect(identity.bytesByKind.javascript).toBe(0);
    expect(identity.entries[0]?.servedEncoding).toBe("identity");
    expect(gzip.entries[0]?.servedEncoding).toBe("gzip");
    expect(gzip.totalBytes).toBeLessThan(identity.totalBytes);
    expect(identity.singleDatagramMet).toBe(true);
    expect(gzip.singleDatagramMet).toBe(true);
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

    const report = await measureFirstLoad(fetchWith(app), "/", "identity");

    expect(report.hardLimitMet).toBe(false);
    expect(() => assertTransferBudget(report)).toThrow(
      /cold load is .* budget is/,
    );
  });

  test("fails when the critical path leaves the origin", async () => {
    const app = new Hono();
    app.get("/", (c) =>
      c.html('<script src="https://example.com/runtime.js"></script>'),
    );

    const report = await measureFirstLoad(fetchWith(app), "/", "identity");

    expect(report.hardLimitMet).toBe(false);
    expect(() => assertTransferBudget(report)).toThrow(/external resources/);
  });
});
