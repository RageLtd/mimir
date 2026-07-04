/**
 * BYOK key forwarding tests (MIM-73).
 *
 * providerEnvByModel is module-level state shared across tests in this
 * file — each test seeds and clears what it uses.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  fetchServerModels,
  providerEnvByModel,
  providerKeyForModel,
  streamCompletion,
} from "./server-client";

const TEST_ENV_VAR = "MIMIR_TEST_FAKE_PROVIDER_KEY";

afterEach(() => {
  providerEnvByModel.clear();
  delete process.env[TEST_ENV_VAR];
  spyOn(globalThis, "fetch").mockRestore();
});

describe("providerKeyForModel", () => {
  test("resolves the key from the model's standard env var", () => {
    providerEnvByModel.set("anthropic/claude-x", TEST_ENV_VAR);
    process.env[TEST_ENV_VAR] = "sk-user";
    expect(providerKeyForModel("anthropic/claude-x")).toBe("sk-user");
  });

  test("unknown model → undefined", () => {
    expect(providerKeyForModel("mystery")).toBeUndefined();
  });

  test("known model but unset env var → undefined", () => {
    providerEnvByModel.set("anthropic/claude-x", TEST_ENV_VAR);
    expect(providerKeyForModel("anthropic/claude-x")).toBeUndefined();
  });
});

describe("fetchServerModels provider_env capture", () => {
  test("populates the model→env map from the response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-x",
              owned_by: "anthropic",
              provider_env: TEST_ENV_VAR,
            },
            { id: "local-model", owned_by: "mimir" },
          ],
        }),
        { status: 200 },
      ),
    );

    await fetchServerModels("http://server", "");

    expect(providerEnvByModel.get("anthropic/claude-x")).toBe(TEST_ENV_VAR);
    expect(providerEnvByModel.has("local-model")).toBe(false);
  });
});

describe("streamCompletion header forwarding", () => {
  const drain = async (iter: AsyncGenerator<unknown>) => {
    // Empty SSE body → the iterator ends immediately.
    for await (const _ of iter) {
      // drain
    }
  };

  const capturedHeaders = () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    return {
      fetchSpy,
      headers: () => {
        const init = fetchSpy.mock.calls[0]?.[1];
        return (init?.headers ?? {}) as Record<string, string>;
      },
    };
  };

  test("forwards X-Provider-Api-Key when the user has a key for the model", async () => {
    providerEnvByModel.set("anthropic/claude-x", TEST_ENV_VAR);
    process.env[TEST_ENV_VAR] = "sk-user";
    const { headers } = capturedHeaders();

    await drain(
      streamCompletion(
        { baseUrl: "http://server", apiKey: "mimir-key" },
        { model: "anthropic/claude-x", messages: [], stream: true },
      ),
    );

    expect(headers()["X-Provider-Api-Key"]).toBe("sk-user");
    // Mimir's own credential rides Authorization, untouched.
    expect(headers().Authorization).toBe("Bearer mimir-key");
  });

  test("no key resolvable → header absent (server defaults apply)", async () => {
    const { headers } = capturedHeaders();

    await drain(
      streamCompletion(
        { baseUrl: "http://server", apiKey: "mimir-key" },
        { model: "anthropic/claude-x", messages: [], stream: true },
      ),
    );

    expect(headers()["X-Provider-Api-Key"]).toBeUndefined();
  });
});
