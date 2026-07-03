/**
 * Provider query API — model resolution, metadata lookup, reasoning/sampling config.
 *
 * All functions read from the registry state maps populated during init.
 * Reasoning and sampling configuration is derived from provider-data.json metadata:
 * the `npm` field determines the providerOptions shape, and `reasoning: true`
 * gates whether reasoning is attempted at all.
 */

import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import {
  bareNameToFullId,
  createProviderSDK,
  getOrCreateSDK,
  initialized,
  modelMetadata,
  modelToProvider,
  providerConfig,
  providerData,
  providerModels,
  providers,
} from "./registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize HF-style model IDs ("Qwen/Qwen3.5") to bare name ("Qwen3.5"). */
function normalizeBareId(modelId: string) {
  if (!modelId.includes("/")) return modelId;
  return modelId.split("/")[1] ?? modelId;
}

// ---------------------------------------------------------------------------
// Provider queries
// ---------------------------------------------------------------------------

export function hasProvider(providerId: string) {
  return providers.has(providerId);
}

export function listProviders() {
  return [...providers.keys()];
}

export function listModels() {
  // Enumerate the per-provider index, not `modelToProvider`. The latter is keyed
  // by model ID, so a model offered by several providers collapses to one
  // winner and bare-name aliases double-list every HF-style id. `providerModels`
  // keeps each provider's full catalogue (canonical IDs only), so every
  // (provider, model) pair surfaces once and stays separately selectable.
  return [...providerModels.entries()].flatMap(([providerId, modelIds]) =>
    modelIds.map((modelId) => ({ modelId, providerId })),
  );
}

export function hasModel(modelId: string) {
  const bareId = normalizeBareId(modelId);
  return modelToProvider.has(bareId) || modelToProvider.has(modelId);
}

export function isRegistryReady() {
  return initialized;
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

export function getModelNpm(modelId: string) {
  const bareId = normalizeBareId(modelId);

  const meta = modelMetadata.get(bareId) ?? modelMetadata.get(modelId);
  if (meta?.provider?.npm) return meta.provider.npm;

  const providerId =
    modelToProvider.get(bareId) ?? modelToProvider.get(modelId);
  if (providerId) {
    const cfg = providerConfig.get(providerId);
    if (cfg?.npm) return cfg.npm;
  }

  return "@ai-sdk/openai-compatible";
}

export function getContextWindow(modelId: string) {
  const bareId = normalizeBareId(modelId);
  return (
    modelMetadata.get(bareId)?.limit?.context ??
    modelMetadata.get(modelId)?.limit?.context
  );
}

export function getModelMetadata(modelId: string) {
  const bareId = normalizeBareId(modelId);
  return modelMetadata.get(bareId) ?? modelMetadata.get(modelId);
}

export function getModelDisplayName(modelId: string) {
  return getModelMetadata(modelId)?.name;
}

export function getProviderDisplayName(providerId: string) {
  return getProviderDisplayNames().get(providerId);
}

// Lazily built on first access — providerData is populated at runtime
// during initProviderRegistry(), not at module load.
let providerDisplayNames: Map<string, string> | null = null;

// Local providers don't appear in provider-data.json, so titlecasing their
// IDs in the ACP picker produces awkward results ("Lmstudio", "Vllm").
// These overrides give them proper display names.
const LOCAL_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  vllm: "vLLM",
};

function getProviderDisplayNames() {
  if (!providerDisplayNames) {
    providerDisplayNames = new Map();
    for (const [id, entry] of Object.entries(
      providerData as Record<string, { name?: string }>,
    )) {
      if (typeof entry.name === "string")
        providerDisplayNames.set(id, entry.name);
    }
    for (const [id, name] of Object.entries(LOCAL_PROVIDER_DISPLAY_NAMES)) {
      if (!providerDisplayNames.has(id)) providerDisplayNames.set(id, name);
    }
  }
  return providerDisplayNames;
}

export function getModelProvider(modelId: string) {
  const bareId = normalizeBareId(modelId);
  return modelToProvider.get(bareId) ?? modelToProvider.get(modelId);
}

/**
 * Get provider config (baseUrl, apiKey) for a model.
 * Handles provider-prefixed IDs like "opencode/gpt5-nano".
 */
export function getProviderConfigForModel(modelId: string) {
  let providerId: string | undefined;
  let bareModelId = modelId;

  const slashIndex = modelId.indexOf("/");
  if (slashIndex !== -1) {
    const candidate = modelId.slice(0, slashIndex);
    if (providers.has(candidate)) {
      providerId = candidate;
      bareModelId = modelId.slice(slashIndex + 1);
    }
  }

  if (!providerId) {
    providerId =
      modelToProvider.get(bareModelId) ?? modelToProvider.get(modelId);
  }

  if (!providerId) return undefined;
  return providerConfig.get(providerId);
}

export function getEmbeddingModelMetadata(modelId: string) {
  const bareId = normalizeBareId(modelId);
  return (
    modelMetadata.get(modelId) ??
    modelMetadata.get(bareId) ??
    [...modelMetadata.entries()].find(
      ([id]) => id.toLowerCase() === modelId.toLowerCase(),
    )?.[1] ??
    [...modelMetadata.entries()].find(
      ([id]) => id.toLowerCase() === bareId.toLowerCase(),
    )?.[1]
  );
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export function resolveModel(modelId: string) {
  if (!initialized) {
    throw new Error(
      "Provider registry not initialized. Call initProviderRegistry() first.",
    );
  }

  // Check for provider prefix (e.g., "opencode-go/glm-5").
  // Only strip when the prefix is a registered provider — model IDs like
  // "accounts/fireworks/models/deepseek-v4-pro" contain slashes that are
  // part of the ID itself, not a provider hint.
  const slashIndex = modelId.indexOf("/");
  let bareModelId = modelId;
  let providerHint: string | undefined;

  if (slashIndex !== -1) {
    const candidate = modelId.slice(0, slashIndex);
    if (providers.has(candidate)) {
      providerHint = candidate;
      bareModelId = modelId.slice(slashIndex + 1);
    }
  }

  // Try with hint first
  if (providerHint) {
    const fullModelId = bareNameToFullId.get(bareModelId) ?? bareModelId;
    const npm = getModelNpm(bareModelId);
    const sdk = getOrCreateSDK(providerHint, npm);
    if (sdk) return sdk.languageModel(fullModelId);
    const provider = providers.get(providerHint);
    if (provider) return provider.languageModel(fullModelId);
  }

  // Look up in index
  const providerId =
    modelToProvider.get(bareModelId) ?? modelToProvider.get(modelId);

  if (providerId) {
    const fullRegisteredId = bareNameToFullId.get(bareModelId);
    const apiModelId = fullRegisteredId ?? bareModelId;
    const npm = getModelNpm(bareModelId);
    const sdk = getOrCreateSDK(providerId, npm);
    if (sdk) return sdk.languageModel(apiModelId);
    const provider = providers.get(providerId);
    if (!provider) {
      throw new Error(
        `Provider ${providerId} not initialized for model ${modelId}`,
      );
    }
    return provider.languageModel(apiModelId);
  }

  // Fallback to vLLM if configured
  const vllm = providers.get("vllm");
  if (vllm) return vllm.languageModel(modelId);

  throw new Error(`No provider found for model ${modelId}`);
}

export function resolveEmbeddingModel() {
  const embedModel =
    Bun.env.EMBED_MODEL ?? Bun.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b";
  const embedBaseUrl =
    Bun.env.EMBED_BASE_URL ??
    Bun.env.OLLAMA_BASE_URL ??
    "http://ollama.spark.lan";
  const embedApiKey = Bun.env.EMBED_API_KEY ?? "";

  const provider = createProviderSDK(
    "@ai-sdk/openai",
    `${embedBaseUrl}/v1`,
    embedApiKey || "not-needed",
  );

  return provider.embeddingModel(embedModel);
}

export async function fetchModelId(baseUrl: string) {
  const [err, res] = await attempt(() =>
    fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) }),
  );
  if (err) {
    log.warn({ err, baseUrl }, "/models fetch failed");
    return null;
  }
  if (!res.ok) {
    log.warn({ baseUrl, status: res.status }, "/models returned error");
    return null;
  }

  const [parseErr, body] = await attempt(
    () => res.json() as Promise<{ data?: Array<{ id: string }> }>,
  );
  if (parseErr) {
    log.warn({ err: parseErr, baseUrl }, "/models parse failed");
    return null;
  }

  const models = body.data?.map((m) => m.id) ?? [];
  if (models.length === 0) {
    log.warn({ baseUrl }, "/models returned empty list");
    return null;
  }
  return models[0] ?? null;
}

export function getSmallModelConfig() {
  const { providerType, baseUrl, apiKey, model } = config.smallModel;

  if (providerType) {
    const normalizedBase = baseUrl.replace(/\/v1$/, "");
    return { baseUrl: normalizedBase, apiKey, model };
  }

  const providerCfg = getProviderConfigForModel(model);
  if (!providerCfg) {
    log.warn({ model }, "no provider found for small model");
    return null;
  }

  const normalizedBase = providerCfg.baseUrl.replace(/\/v1$/, "");
  return { baseUrl: normalizedBase, apiKey: providerCfg.apiKey, model };
}

// ---------------------------------------------------------------------------
// Reasoning & sampling — driven by provider-data.json metadata
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_BUDGET = 32_000;

function effortToBudget(effort: string | undefined, defaultBudget: number) {
  if (!effort) return defaultBudget;
  switch (effort.toLowerCase()) {
    case "none":
      return null;
    case "low":
      return Math.round(defaultBudget * 0.25);
    case "medium":
      return Math.round(defaultBudget * 0.5);
    case "high":
      return defaultBudget;
    default:
      return defaultBudget;
  }
}

/**
 * Build providerOptions for reasoning based on the model's npm SDK type.
 * The `reasoning` flag in provider-data.json gates entry; the `npm` field
 * determines the shape of the options object each SDK expects.
 */
export function getReasoningOptions(
  modelId: string,
  effort?: string,
): SharedV3ProviderOptions {
  const meta = getModelMetadata(modelId);
  if (!meta?.reasoning) return {};

  // OpenRouter handles reasoning via its own routing param
  const providerId = getModelProvider(modelId);
  if (providerId === "openrouter") return {};

  const npm = getModelNpm(modelId);
  const budget = effortToBudget(effort, DEFAULT_REASONING_BUDGET);

  // "none" → skip reasoning entirely
  if (budget === null) return {};

  // Models with interleaved thinking (DeepSeek, Kimi, etc.) manage reasoning
  // server-side — sending provider options causes 500s on Fireworks/Together.
  if (meta.interleaved) return {};

  switch (npm) {
    case "@ai-sdk/anthropic":
      return {
        anthropic: {
          thinking: { type: "enabled" as const, budgetTokens: budget },
        },
      };

    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return { google: { thinkingConfig: { thinkingBudget: budget } } };

    case "@ai-sdk/moonshotai":
      return {
        moonshotai: {
          thinking: { type: "enabled" as const, budgetTokens: budget },
          reasoningHistory: "interleaved" as const,
        },
      };

    case "@ai-sdk/openai":
      return { openai: { reasoningEffort: effort ?? "high" } };

    case "@ai-sdk/openai-compatible":
      // Only OpenAI proper supports reasoningEffort; other providers behind
      // openai-compatible (Fireworks, Together, Groq, etc.) don't recognize it.
      return {};

    default:
      return {};
  }
}
