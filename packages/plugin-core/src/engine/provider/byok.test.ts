/**
 * BYOK resolution tests (MIM-73). The registry is handed a fixed
 * models.dev-shaped catalogue with none of its providers' env keys set, so
 * the registry maps stay EMPTY — these tests exercise exactly the
 * unregistered-provider path a cloud user hits when the server holds no key
 * for their provider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getContextWindow,
  getModelMetadata,
  getModelProvider,
  getProviderEnvVar,
  resolveModelWithOverride,
} from "./query";
import {
  initProviderRegistry,
  modelToProvider,
  type ProviderEntry,
  providerConfig,
  providerSdks,
  providers,
} from "./registry";

const catalogue: Record<string, ProviderEntry> = {
  // NO `api` field — mirrors the real models.dev entry: SDK-native
  // providers rely on their SDK's default endpoint. The first live smoke
  // failed precisely because the original fixture invented an api URL.
  anthropic: {
    id: "anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    name: "Anthropic",
    models: {
      "claude-test": {
        id: "claude-test",
        reasoning: true,
        limit: { context: 200000 },
      },
    },
  },
  // Deliberately no `api` and no `npm` — exercises the base_url error
  // path and the openai-compatible npm default.
  customhost: {
    id: "customhost",
    env: ["CUSTOM_API_KEY"],
    name: "Custom Host",
    models: { "custom-model": { id: "custom-model" } },
  },
};

// Unset every key that would register a provider: the catalogue's own
// (keeps the BYOK path unregistered) and the local providers' (which would
// otherwise trigger live /models fetches). Restored after, since other
// files may share this process.
const UNSET_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CUSTOM_API_KEY",
  "VLLM_BASE_URL",
  "OLLAMA_BASE_URL",
  "LMSTUDIO_BASE_URL",
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of UNSET_ENV_KEYS) {
  savedEnv.set(key, Bun.env[key]);
  delete Bun.env[key];
}

beforeAll(async () => {
  providers.clear();
  providerSdks.clear();
  providerConfig.clear();
  modelToProvider.clear();
  await initProviderRegistry(catalogue);
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
});

describe("resolveModelWithOverride", () => {
  test("explicit provider resolves an unregistered provider's model", () => {
    const model = resolveModelWithOverride("claude-test", {
      apiKey: "sk-user",
      provider: "anthropic",
    });
    expect(model).toBeTruthy();
  });

  test("provider/model prefix convention works for models.dev-known providers", () => {
    const model = resolveModelWithOverride("anthropic/claude-test", {
      apiKey: "sk-user",
    });
    expect(model).toBeTruthy();
  });

  test("unresolvable provider → clear error", () => {
    expect(() =>
      resolveModelWithOverride("mystery-model", { apiKey: "sk-user" }),
    ).toThrow(/cannot determine provider/);
  });

  test("provider without a base URL demands metadata.base_url", () => {
    expect(() =>
      resolveModelWithOverride("custom-model", {
        apiKey: "sk-user",
        provider: "customhost",
      }),
    ).toThrow(/no base URL/);
  });

  test("base_url override unblocks providers without a catalogue URL", () => {
    const model = resolveModelWithOverride("custom-model", {
      apiKey: "sk-user",
      provider: "customhost",
      baseUrl: "http://llm.internal/v1",
    });
    expect(model).toBeTruthy();
  });

  test("SECURITY: BYOK resolution never touches the shared SDK caches", () => {
    const sdksBefore = providerSdks.size;
    const providersBefore = providers.size;
    const configBefore = providerConfig.size;

    resolveModelWithOverride("anthropic/claude-test", { apiKey: "sk-user" });

    expect(providerSdks.size).toBe(sdksBefore);
    expect(providers.size).toBe(providersBefore);
    expect(providerConfig.size).toBe(configBefore);
  });
});

describe("metadata fallbacks for unregistered providers", () => {
  test("getModelMetadata reads the raw provider data", () => {
    expect(getModelMetadata("claude-test")?.reasoning).toBe(true);
  });

  test("getContextWindow flows through the fallback", () => {
    expect(getContextWindow("claude-test")).toBe(200000);
  });

  test("getModelProvider identifies the owning provider", () => {
    expect(getModelProvider("claude-test")).toBe("anthropic");
  });

  test("getProviderEnvVar surfaces the standard env var name", () => {
    expect(getProviderEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getProviderEnvVar("nonexistent")).toBeUndefined();
  });
});
