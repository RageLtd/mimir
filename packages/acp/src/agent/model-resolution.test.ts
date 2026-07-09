/**
 * Model resolution tests.
 *
 * Verifies that `buildModelsState` honours `preferredModelId` so the picker
 * in Zed reflects the session's actual current model rather than snapping
 * back to the env-var default. Models are injected by seeding the local
 * provider registry's `providerModels` map (MIM-89 — the /v1/models fetch
 * died with the inversion); engine boot is mocked out so tests never touch
 * the network.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { providerModels } from "@mimir/plugin-core/engine/provider";
import type { MimirConfig } from "../config";

mock.module("../engine-boot", () => ({
  ensureEngineReady: async () => {},
  getSystemPrompt: async () => "",
}));

import { buildModelsState, type ModelResolutionDeps } from "./model-resolution";

/** Seed the local registry with the given model ids under one provider. */
const stubLocalModels = (ids: readonly string[]) => {
  providerModels.clear();
  if (ids.length > 0) providerModels.set("test-provider", [...ids]);
};

beforeEach(() => {
  // Default: registry holds no models. Tests that need entries override.
  stubLocalModels([]);
});

afterEach(() => {
  providerModels.clear();
});

const mkConfig = (model: string) =>
  ({
    serverUrl: "http://test.invalid",
    apiKey: "",
    model,
    smallModel: "",
    userMemoryDbPath: "/tmp/test.db",
    sessionDbPath: "/tmp/test-sessions.db",
    logLevel: "warn",
    acpLogPath: "",
    autoApproveTools: false,
    cartographer: { enabled: false, binaryPath: "cartographer" },
  }) satisfies MimirConfig;

const mkDeps = (config: MimirConfig) =>
  ({
    config,
    serverReasoningModels: new Set<string>(),
  }) satisfies ModelResolutionDeps;

describe("buildModelsState — preferredModelId", () => {
  test("uses preferredModelId when it matches a discovered model", async () => {
    stubLocalModels([
      "openrouter/opus",
      "openrouter/sonnet",
      "openrouter/haiku",
    ]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps, "openrouter/sonnet");

    expect(result.currentModelId).toBe("openrouter/sonnet");
  });

  test("preferred wins over the configured default", async () => {
    // The user-selected model (preferred) must take priority over MIMIR_MODEL,
    // otherwise the picker snaps back to the env-var default after every
    // setSessionConfigOption round-trip.
    stubLocalModels(["openrouter/opus", "openrouter/sonnet"]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps, "openrouter/sonnet");

    expect(result.currentModelId).toBe("openrouter/sonnet");
    expect(result.currentModelId).not.toBe("openrouter/opus");
  });

  test("falls back to configured when preferred isn't in the list", async () => {
    stubLocalModels(["openrouter/opus", "openrouter/sonnet"]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps, "openrouter/nonexistent");

    expect(result.currentModelId).toBe("openrouter/opus");
  });

  test("falls back to first available when neither preferred nor configured matches", async () => {
    stubLocalModels(["openrouter/sonnet", "openrouter/haiku"]);
    const deps = mkDeps(mkConfig("openrouter/auto"));

    const result = await buildModelsState(deps, "openrouter/missing");

    expect(result.currentModelId).toBe("openrouter/sonnet");
  });

  test("empty config.model defaults to first available (no configured default)", async () => {
    // MIMIR_MODEL unset → config.model is "". Resolution must skip the
    // configured lookup and select the first discovered model so Zed's
    // picker renders with a valid current selection rather than "".
    stubLocalModels(["claude-fable-5", "claude-opus-4-8"]);
    const deps = mkDeps(mkConfig(""));

    const result = await buildModelsState(deps);

    expect(result.currentModelId).toBe("claude-fable-5");
  });

  test("preserves preferredModelId verbatim when no models discovered", async () => {
    // Edge case: discovery returns nothing (no env keys, no local
    // providers). The session's persisted model id should still come back
    // so it survives a transient failure.
    stubLocalModels([]);
    const deps = mkDeps(mkConfig("openrouter/auto"));

    const result = await buildModelsState(deps, "openrouter/sonnet");

    expect(result.currentModelId).toBe("openrouter/sonnet");
    expect(result.availableModels).toHaveLength(0);
  });

  test("omitting preferredModelId reverts to configured-default behaviour", async () => {
    stubLocalModels(["openrouter/opus", "openrouter/sonnet"]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps);

    expect(result.currentModelId).toBe("openrouter/opus");
  });
});
