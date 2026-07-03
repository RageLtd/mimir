/**
 * Tests for listModels — it enumerates the per-provider `providerModels` index
 * so every (provider, model) pair surfaces distinctly. A model offered by two
 * providers must appear twice (once per provider), not collapse to one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { listModels } from "./query";
import { providerModels } from "./registry";

// Provider keys this test injects into the shared map, cleaned up after each.
const INJECTED = ["test-zen", "test-go", "test-chutes"] as const;

afterEach(() => {
  for (const k of INJECTED) providerModels.delete(k);
});

describe("listModels", () => {
  test("lists every model of a provider", () => {
    providerModels.set("test-chutes", ["plain", "acme/Big-Model"]);

    const ids = listModels()
      .filter((m) => m.providerId === "test-chutes")
      .map((m) => m.modelId);

    expect(ids).toEqual(["plain", "acme/Big-Model"]);
  });

  test("same model under two providers yields two distinct entries", () => {
    providerModels.set("test-zen", ["glm-5.1"]);
    providerModels.set("test-go", ["glm-5.1"]);

    const entries = listModels().filter((m) => m.modelId === "glm-5.1");

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.providerId).sort()).toEqual([
      "test-go",
      "test-zen",
    ]);
  });

  test("returns provider+model pairs, not bare-name aliases", () => {
    // providerModels holds canonical ids only — the bare-name aliases that
    // registerModels injects into modelToProvider never reach this index.
    providerModels.set("test-chutes", ["acme/Big-Model"]);

    const ids = listModels()
      .filter((m) => m.providerId === "test-chutes")
      .map((m) => m.modelId);

    expect(ids).toContain("acme/Big-Model");
    expect(ids).not.toContain("Big-Model");
  });
});
