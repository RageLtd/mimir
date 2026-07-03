/**
 * Tests for the GET /v1/models route.
 *
 * - buildLocalModels: the optional self-hosted vLLM entry. An unset
 *   `VLLM_MODEL` must emit nothing rather than a blank-id entry that sorts
 *   first in the picker and breaks selection.
 * - bareModelId: recovers the metadata-lookup key from a provider-qualified id.
 * - route: every model is emitted provider-qualified, cross-provider variants
 *   stay distinct, and ids are deduped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { providerModels } from "../agent/provider/registry";
import { bareModelId, buildLocalModels, models } from "./models";

describe("buildLocalModels", () => {
  test("emits no entry when no local model is configured", () => {
    expect(buildLocalModels("", 123)).toEqual([]);
  });

  test("emits a single mimir-owned entry when a local model is set", () => {
    const result = buildLocalModels("Qwen/Qwen3.5-122B-A10B", 123);
    expect(result).toEqual([
      {
        id: "Qwen/Qwen3.5-122B-A10B",
        object: "model",
        created: 123,
        owned_by: "mimir",
      },
    ]);
  });

  test("never produces a blank id", () => {
    for (const entry of buildLocalModels("", 0)) {
      expect(entry.id).not.toBe("");
    }
    expect(buildLocalModels("real-model", 0)[0]?.id).toBe("real-model");
  });
});

describe("bareModelId", () => {
  test("strips the provider qualifier", () => {
    expect(
      bareModelId({ id: "opencode-go/glm-5.1", owned_by: "opencode-go" }),
    ).toBe("glm-5.1");
  });

  test("strips only the provider prefix, preserving nested slashes", () => {
    expect(
      bareModelId({
        id: "chutes/moonshotai/Kimi-K2.6-TEE",
        owned_by: "chutes",
      }),
    ).toBe("moonshotai/Kimi-K2.6-TEE");
  });

  test("passes an unqualified id (local mimir entry) through unchanged", () => {
    expect(bareModelId({ id: "Qwen/Qwen3.5", owned_by: "mimir" })).toBe(
      "Qwen/Qwen3.5",
    );
  });
});

describe("GET /v1/models", () => {
  const INJECTED = ["unit-zen", "unit-go"] as const;

  afterEach(() => {
    for (const k of INJECTED) providerModels.delete(k);
  });

  const fetchIds = async () => {
    const res = await models.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return body.data.map((m) => m.id);
  };

  test("emits provider-qualified ids, keeping cross-provider variants distinct", async () => {
    providerModels.set("unit-zen", ["glm-5.1"]);
    providerModels.set("unit-go", ["glm-5.1", "mimo-v2-pro"]);

    const ids = await fetchIds();

    expect(ids).toContain("unit-zen/glm-5.1");
    expect(ids).toContain("unit-go/glm-5.1");
    expect(ids).toContain("unit-go/mimo-v2-pro");
  });

  test("dedups repeated ids from the same provider", async () => {
    providerModels.set("unit-go", ["glm-5.1", "glm-5.1"]);

    const ids = await fetchIds();
    const occurrences = ids.filter((id) => id === "unit-go/glm-5.1").length;

    expect(occurrences).toBe(1);
  });
});
