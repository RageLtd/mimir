/**
 * Provider query API — model resolution, metadata lookup, and provider config access.
 *
 * All functions read from the registry state maps populated during init.
 * Import state from ./registry; this module is pure query logic with no side effects.
 */

import type { EmbeddingModel } from "ai";
import providerData from "../../../provider-data.json";
import { config } from "../../config";
import { log } from "../../util/logger";
import {
  bareNameToFullId,
  createProviderSDK,
  getOrCreateSDK,
  initialized,
  type ModelEntry,
  modelMetadata,
  modelToProvider,
  providerConfig,
  providers,
} from "./registry";

// ---------------------------------------------------------------------------
// Provider queries
// ---------------------------------------------------------------------------

/**
 * Check if a provider is initialized.
 */
export function hasProvider(providerId: string): boolean {
  return providers.has(providerId);
}

/**
 * List all initialized providers.
 */
export function listProviders(): string[] {
  return [...providers.keys()];
}

/**
 * List all registered models.
 */
export function listModels(): { modelId: string; providerId: string }[] {
  return [...modelToProvider.entries()].map(([modelId, providerId]) => ({
    modelId,
    providerId,
  }));
}

/**
 * Check if a model is registered.
 */
export function hasModel(modelId: string): boolean {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;
  return modelToProvider.has(bareId) || modelToProvider.has(modelId);
}

/**
 * Check if the registry has been initialized.
 */
export function isRegistryReady(): boolean {
  return initialized;
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

/**
 * Get the npm SDK type for a model.
 * Returns the model's override npm if set, otherwise the provider's default npm.
 */
export function getModelNpm(modelId: string): string {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;

  // Check for model-level npm override
  const meta = modelMetadata.get(bareId) ?? modelMetadata.get(modelId);
  if (meta?.provider?.npm) {
    return meta.provider.npm;
  }

  // Fall back to provider's default npm
  const providerId =
    modelToProvider.get(bareId) ?? modelToProvider.get(modelId);
  if (providerId) {
    const cfg = providerConfig.get(providerId);
    if (cfg?.npm) {
      return cfg.npm;
    }
  }

  return "@ai-sdk/openai-compatible";
}

/**
 * Get context window for a model from provider-data.json metadata.
 */
export function getContextWindow(modelId: string): number | undefined {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;
  return (
    modelMetadata.get(bareId)?.limit?.context ??
    modelMetadata.get(modelId)?.limit?.context
  );
}

/**
 * Get model metadata from provider-data.json.
 */
export function getModelMetadata(modelId: string): ModelEntry | undefined {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;
  return modelMetadata.get(bareId) ?? modelMetadata.get(modelId);
}

/**
 * Get the human-readable display name for a model from provider-data.
 * Falls back to undefined when the model isn't in the registry — caller
 * should display the raw id in that case.
 */
export function getModelDisplayName(modelId: string) {
  return getModelMetadata(modelId)?.name;
}

/**
 * Get the human-readable display name for a provider from provider-data.
 * Looks up `providerData[providerId].name`. Returns undefined when the
 * provider isn't registered (e.g. ad-hoc owned_by values from external
 * APIs); caller should fall back to titlecasing the providerId.
 */
export function getProviderDisplayName(providerId: string) {
  return providerDisplayNames.get(providerId);
}

// Build the display-name map once at module load. Keys are providerIds
// from provider-data.json; values are the `name` field.
const providerDisplayNames = (() => {
  const map = new Map<string, string>();
  for (const [id, entry] of Object.entries(
    providerData as Record<string, { name?: string }>,
  )) {
    if (typeof entry.name === "string") map.set(id, entry.name);
  }
  return map;
})();

/**
 * Get provider ID for a model.
 */
export function getModelProvider(modelId: string): string | undefined {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;
  return modelToProvider.get(bareId) ?? modelToProvider.get(modelId);
}

/**
 * Get provider config (baseUrl, apiKey) for a model.
 * Useful for raw fetch operations that need the endpoint directly.
 */
export function getProviderConfigForModel(
  modelId: string,
): { baseUrl: string; apiKey: string } | undefined {
  let providerId: string | undefined;
  let bareModelId = modelId;

  // Check for provider prefix (e.g., "opencode/gpt5-nano")
  const slashIndex = modelId.indexOf("/");
  if (slashIndex !== -1) {
    const providerHint = modelId.slice(0, slashIndex);
    bareModelId = modelId.slice(slashIndex + 1);

    // If the hint matches a known provider, use it
    if (providers.has(providerHint)) {
      providerId = providerHint;
    }
  }

  // Fall back to model index lookup
  if (!providerId) {
    providerId =
      modelToProvider.get(bareModelId) ?? modelToProvider.get(modelId);
  }

  if (!providerId) return undefined;
  return providerConfig.get(providerId);
}

/**
 * Get embedding model metadata from provider-data.
 */
export function getEmbeddingModelMetadata(
  modelId: string,
): ModelEntry | undefined {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;

  const meta =
    modelMetadata.get(modelId) ??
    modelMetadata.get(bareId) ??
    [...modelMetadata.entries()].find(
      ([id]) => id.toLowerCase() === modelId.toLowerCase(),
    )?.[1] ??
    [...modelMetadata.entries()].find(
      ([id]) => id.toLowerCase() === bareId.toLowerCase(),
    )?.[1];

  return meta;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model ID to a LanguageModel instance.
 * Uses the model's npm override if set, otherwise the provider's default npm.
 */
export function resolveModel(modelId: string) {
  if (!initialized) {
    throw new Error(
      "Provider registry not initialized. Call initProviderRegistry() first.",
    );
  }

  // Check for provider prefix (e.g., "opencode-go/glm-5")
  const slashIndex = modelId.indexOf("/");
  let bareModelId = modelId;
  let providerHint: string | undefined;

  if (slashIndex !== -1) {
    providerHint = modelId.slice(0, slashIndex);
    bareModelId = modelId.slice(slashIndex + 1);
  }

  // Try with hint first
  if (providerHint && providers.has(providerHint)) {
    // Reconstruct full HF-style model ID if needed
    const fullModelId = bareNameToFullId.get(bareModelId) ?? bareModelId;
    const npm = getModelNpm(bareModelId);
    const sdk = getOrCreateSDK(providerHint, npm);
    if (sdk) {
      return sdk.languageModel(fullModelId);
    }
    // Fall back to default SDK for this provider
    const provider = providers.get(providerHint);
    if (provider) {
      return provider.languageModel(fullModelId);
    }
  }

  // Look up in index
  const providerId =
    modelToProvider.get(bareModelId) ?? modelToProvider.get(modelId);

  if (providerId) {
    const fullRegisteredId = bareNameToFullId.get(bareModelId);
    const apiModelId = fullRegisteredId ?? bareModelId;
    const npm = getModelNpm(bareModelId);
    const sdk = getOrCreateSDK(providerId, npm);
    if (sdk) {
      return sdk.languageModel(apiModelId);
    }
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
  if (vllm) {
    return vllm.languageModel(modelId);
  }

  throw new Error(`No provider found for model ${modelId}`);
}

/**
 * Resolve embedding model for local inference.
 */
export function resolveEmbeddingModel(): EmbeddingModel {
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

/**
 * Fetch model ID from a local /models endpoint.
 */
export async function fetchModelId(baseUrl: string): Promise<string | null> {
  const { attempt } = await import("../../util/result");

  const [err, res] = await attempt(() =>
    fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    }),
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

/**
 * Resolve the small model configuration.
 */
export function getSmallModelConfig(): {
  baseUrl: string;
  apiKey: string;
  model: string;
} | null {
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
