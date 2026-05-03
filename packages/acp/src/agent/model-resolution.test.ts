/**
 * Model resolution tests.
 *
 * Verifies that `buildModelsState` honours `preferredModelId` so the picker
 * in Zed reflects the session's actual current model rather than snapping
 * back to the env-var default. Uses fetch stubbing rather than a live
 * server — mimir-server isn't reachable from test runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { BackendRouter } from "../backends";
import type { MimirConfig } from "../config";
import { buildModelsState, type ModelResolutionDeps } from "./model-resolution";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Default stub: server returns empty model list. Tests that need
  // server entries override this.
  globalThis.fetch = (async (
    _url: string | URL | Request,
    _init?: RequestInit,
  ) =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mkRouter = (
  overrides?: Partial<BackendRouter["runtime"]>,
): BackendRouter => ({
  forModel: () => ({ kind: "claude-code" }) as never,
  server: {} as never,
  cc: {} as never,
  copilot: {} as never,
  runtime: {
    ccEnabled: true,
    copilotEnabled: false,
    copilotModelMap: new Map(),
    ...overrides,
  },
});

const mkConfig = (model: string): MimirConfig =>
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
    cc: {} as never,
    copilot: {} as never,
    cartographer: {} as never,
  }) as MimirConfig;

const ccModel = (suffix: string): acp.ModelInfo => ({
  modelId: `claude-code/${suffix}`,
  name: `Claude Code (${suffix})`,
  description: undefined,
});

const mkDeps = (
  config: MimirConfig,
  ccModels: readonly acp.ModelInfo[],
): ModelResolutionDeps => ({
  config,
  router: mkRouter(),
  getDiscoveredCCModels: () => ccModels,
  getDiscoveredCopilotModels: () => [],
});

describe("buildModelsState — preferredModelId", () => {
  test("uses preferredModelId when it matches a discovered model", async () => {
    const deps = mkDeps(mkConfig("claude-code/opus"), [
      ccModel("opus"),
      ccModel("sonnet"),
      ccModel("haiku"),
    ]);

    const result = await buildModelsState(deps, "claude-code/sonnet");

    expect(result.currentModelId).toBe("claude-code/sonnet");
  });

  test("preferred wins over the configured default", async () => {
    // The user-selected model (preferred) must take priority over MIMIR_MODEL,
    // otherwise the picker snaps back to "Default (recommended)" after every
    // setSessionConfigOption round-trip.
    const deps = mkDeps(mkConfig("claude-code/opus"), [
      ccModel("opus"),
      ccModel("sonnet"),
    ]);

    const result = await buildModelsState(deps, "claude-code/sonnet");

    expect(result.currentModelId).toBe("claude-code/sonnet");
    expect(result.currentModelId).not.toBe("claude-code/opus");
  });

  test("falls back to configured when preferred isn't in the list", async () => {
    const deps = mkDeps(mkConfig("claude-code/opus"), [
      ccModel("opus"),
      ccModel("sonnet"),
    ]);

    const result = await buildModelsState(deps, "claude-code/nonexistent");

    expect(result.currentModelId).toBe("claude-code/opus");
  });

  test("falls back to first available when neither preferred nor configured matches", async () => {
    const deps = mkDeps(mkConfig("openrouter/auto"), [
      ccModel("sonnet"),
      ccModel("haiku"),
    ]);

    const result = await buildModelsState(deps, "claude-code/missing");

    expect(result.currentModelId).toBe("claude-code/sonnet");
  });

  test("preserves preferredModelId verbatim when no models discovered", async () => {
    // Edge case: all backends offline. The session's persisted model id
    // should still come back so it survives a transient discovery failure.
    const deps = mkDeps(mkConfig("openrouter/auto"), []);

    const result = await buildModelsState(deps, "claude-code/sonnet");

    expect(result.currentModelId).toBe("claude-code/sonnet");
    expect(result.availableModels).toHaveLength(0);
  });

  test("omitting preferredModelId reverts to configured-default behaviour", async () => {
    const deps = mkDeps(mkConfig("claude-code/opus"), [
      ccModel("opus"),
      ccModel("sonnet"),
    ]);

    const result = await buildModelsState(deps);

    expect(result.currentModelId).toBe("claude-code/opus");
  });
});
