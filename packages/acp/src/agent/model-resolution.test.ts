/**
 * Model resolution tests.
 *
 * Verifies that `buildModelsState` honours `preferredModelId` so the picker
 * in Zed reflects the session's actual current model rather than snapping
 * back to the env-var default. Server models are injected by stubbing the
 * `/v1/models` fetch — mimir-server isn't reachable from test runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MimirConfig } from "../config";
import { buildModelsState, type ModelResolutionDeps } from "./model-resolution";

let originalFetch: typeof fetch;

/** Stub `/v1/models` to return the given model ids as server entries. */
const stubServerModels = (ids: readonly string[]) => {
  globalThis.fetch = (async (
    _url: string | URL | Request,
    _init?: RequestInit,
  ) =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Default: server returns no models. Tests that need entries override.
  stubServerModels([]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mkConfig = (model: string) =>
  ({
    serverUrl: "http://test.invalid",
    apiKey: "",
    model,
    userMemoryDbPath: "/tmp/test.db",
    sessionDbPath: "/tmp/test-sessions.db",
    logLevel: "warn",
    acpLogPath: "",
    autoApproveTools: false,
    systemPromptTtlMs: 0,
    cartographer: { enabled: false, binaryPath: "cartographer" },
  }) satisfies MimirConfig;

const mkDeps = (config: MimirConfig) =>
  ({
    config,
    serverReasoningModels: new Set<string>(),
  }) satisfies ModelResolutionDeps;

describe("buildModelsState — preferredModelId", () => {
  test("uses preferredModelId when it matches a discovered model", async () => {
    stubServerModels([
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
    stubServerModels(["openrouter/opus", "openrouter/sonnet"]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps, "openrouter/sonnet");

    expect(result.currentModelId).toBe("openrouter/sonnet");
    expect(result.currentModelId).not.toBe("openrouter/opus");
  });

  test("falls back to configured when preferred isn't in the list", async () => {
    stubServerModels(["openrouter/opus", "openrouter/sonnet"]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps, "openrouter/nonexistent");

    expect(result.currentModelId).toBe("openrouter/opus");
  });

  test("falls back to first available when neither preferred nor configured matches", async () => {
    stubServerModels(["openrouter/sonnet", "openrouter/haiku"]);
    const deps = mkDeps(mkConfig("openrouter/auto"));

    const result = await buildModelsState(deps, "openrouter/missing");

    expect(result.currentModelId).toBe("openrouter/sonnet");
  });

  test("empty config.model defaults to first available (no configured default)", async () => {
    // MIMIR_MODEL unset → config.model is "". Resolution must skip the
    // configured lookup and select the first discovered model so Zed's
    // picker renders with a valid current selection rather than "".
    stubServerModels(["claude-fable-5", "claude-opus-4-8"]);
    const deps = mkDeps(mkConfig(""));

    const result = await buildModelsState(deps);

    expect(result.currentModelId).toBe("claude-fable-5");
  });

  test("preserves preferredModelId verbatim when no models discovered", async () => {
    // Edge case: server discovery returns nothing. The session's persisted
    // model id should still come back so it survives a transient failure.
    stubServerModels([]);
    const deps = mkDeps(mkConfig("openrouter/auto"));

    const result = await buildModelsState(deps, "openrouter/sonnet");

    expect(result.currentModelId).toBe("openrouter/sonnet");
    expect(result.availableModels).toHaveLength(0);
  });

  test("omitting preferredModelId reverts to configured-default behaviour", async () => {
    stubServerModels(["openrouter/opus", "openrouter/sonnet"]);
    const deps = mkDeps(mkConfig("openrouter/opus"));

    const result = await buildModelsState(deps);

    expect(result.currentModelId).toBe("openrouter/opus");
  });
});
