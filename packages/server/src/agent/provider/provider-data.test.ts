import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  getProviderData,
  loadProviderData,
  nextRefreshDelay,
} from "./provider-data";

/**
 * NOTE: the module-level store persists across tests in this file, and the
 * tests below deliberately run as a sequence: fail-while-empty → succeed →
 * fail-after-success. bun test executes tests in a file in order.
 */

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  // Restore the real fetch after each test — each test installs its own spy.
  spyOn(globalThis, "fetch").mockRestore();
});

describe("nextRefreshDelay", () => {
  test("fast retry while the store is empty", () => {
    expect(nextRefreshDelay(false)).toBe(15 * 60 * 1000);
  });

  test("full TTL once data is loaded", () => {
    expect(nextRefreshDelay(true)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("loadProviderData (sequential — shared module store)", () => {
  test("fetch failure with an empty store → false, store stays empty", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const loaded = await loadProviderData();

    expect(loaded).toBe(false);
    expect(Object.keys(getProviderData())).toHaveLength(0);
  });

  test("non-OK response with an empty store → false", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    );

    const loaded = await loadProviderData();

    expect(loaded).toBe(false);
    expect(Object.keys(getProviderData())).toHaveLength(0);
  });

  test("successful fetch populates the store", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({
        anthropic: {
          id: "anthropic",
          env: ["ANTHROPIC_API_KEY"],
          npm: "@ai-sdk/anthropic",
          name: "Anthropic",
          models: { "claude-test": { id: "claude-test" } },
        },
      }),
    );

    const loaded = await loadProviderData();

    expect(loaded).toBe(true);
    expect(getProviderData().anthropic?.name).toBe("Anthropic");
  });

  test("fetch failure after a success → true, stale data preserved", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("outage"));

    const loaded = await loadProviderData();

    // Stale beats empty: the previous test's data is still served.
    expect(loaded).toBe(true);
    expect(getProviderData().anthropic?.name).toBe("Anthropic");
  });
});
