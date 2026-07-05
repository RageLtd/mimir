/**
 * Registration-path tests (MIM-78). The BYOK path (byok.test.ts) already
 * handles api-less entries correctly; these prove boot registration does
 * too — no fabricated base URLs, loud skip for url-less providers with no
 * SDK-native factory, and lockstep between SDK_NATIVE_NPMS and the
 * createProviderSDK switch.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("./provider-data", () => ({
  getProviderData: () => ({
    // Mirrors the REAL models.dev cohere entry: npm set, NO `api` field.
    // The old registry fabricated https://cohere.example.com/v1 here and
    // registered 14 models that could only fail at call time.
    cohere: {
      id: "cohere",
      env: ["COHERE_API_KEY"],
      npm: "@ai-sdk/cohere",
      name: "Cohere",
      models: {
        "command-test": { id: "command-test", limit: { context: 128000 } },
      },
    },
    // No api AND no npm → openai-compatible fallback with nowhere to
    // point. Must be skipped, not registered against a fake URL.
    brokenhost: {
      id: "brokenhost",
      env: ["BROKENHOST_API_KEY"],
      name: "Broken Host",
      models: { "broken-model": { id: "broken-model" } },
    },
  }),
}));

import {
  createProviderSDK,
  initProviderRegistry,
  isSdkNativeNpm,
  modelToProvider,
  providerConfig,
  providers,
  SDK_NATIVE_NPMS,
} from "./registry";

// Local-provider env vars would trigger live /models fetches during
// initProviderRegistry — neutralise them for the test run. Each test file
// runs in its own process under the harness, but restore anyway.
const LOCAL_ENV_KEYS = [
  "VLLM_BASE_URL",
  "OLLAMA_BASE_URL",
  "LMSTUDIO_BASE_URL",
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of LOCAL_ENV_KEYS) {
  savedEnv.set(key, Bun.env[key]);
  delete Bun.env[key];
}
savedEnv.set("COHERE_API_KEY", Bun.env.COHERE_API_KEY);
savedEnv.set("BROKENHOST_API_KEY", Bun.env.BROKENHOST_API_KEY);
Bun.env.COHERE_API_KEY = "test-cohere-key";
Bun.env.BROKENHOST_API_KEY = "test-broken-key";

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
});

describe("initProviderRegistry with api-less entries (MIM-78)", () => {
  beforeEach(() => {
    providers.clear();
    providerConfig.clear();
    modelToProvider.clear();
  });

  test("SDK-native provider without an api URL registers with undefined baseUrl", async () => {
    await initProviderRegistry();

    expect(providers.has("cohere")).toBe(true);
    expect(providerConfig.get("cohere")?.baseUrl).toBeUndefined();
    expect(modelToProvider.get("command-test")).toBe("cohere");
  });

  test("url-less provider with no SDK-native factory is skipped, not fabricated", async () => {
    await initProviderRegistry();

    expect(providers.has("brokenhost")).toBe(false);
    expect(providerConfig.has("brokenhost")).toBe(false);
    expect(modelToProvider.has("broken-model")).toBe(false);
  });
});

describe("SDK_NATIVE_NPMS ↔ createProviderSDK lockstep", () => {
  test("every declared native npm builds an SDK with no base URL", () => {
    for (const npm of SDK_NATIVE_NPMS) {
      expect(isSdkNativeNpm(npm)).toBe(true);
      // Throwing here means the npm is in the set but has no switch case —
      // the drift MIM-78 exists to prevent.
      expect(createProviderSDK(npm, undefined, "test-key")).toBeTruthy();
    }
  });

  test("unlisted npm without a URL is refused loudly", () => {
    expect(isSdkNativeNpm("@ai-sdk/imaginary")).toBe(false);
    expect(() =>
      createProviderSDK("@ai-sdk/imaginary", undefined, "test-key"),
    ).toThrow(/requires a base URL/);
  });
});
