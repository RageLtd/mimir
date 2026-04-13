/**
 * Provider registry — loads provider-data.json and manages model → provider mapping.
 *
 * At boot:
 *   1. Initialize providers for configured API keys (from provider-data.json)
 *   2. Initialize local providers (vLLM, Ollama) for configured base URLs
 *   3. Fetch models from local providers' /models endpoints
 *   4. Index all models: modelId → providerId, modelId → metadata
 *
 * Model resolution:
 *   1. Strip prefix if present (e.g., "opencode-go/glm-5" → provider "opencode-go", model "glm-5")
 *   2. Look up in index → get provider ID and npm type
 *   3. Get SDK for (providerId, npm) combination
 *   4. Return LanguageModel
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel } from "ai";
import providerData from "../../../provider-data.json";
import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";

// ---------------------------------------------------------------------------
// Types from provider-data.json
// ---------------------------------------------------------------------------

export interface ProviderEntry {
  id: string;
  env: string[];
  npm: string;
  api?: string;
  name: string;
  models: Record<string, ModelEntry>;
  [key: string]: unknown;
}

export interface ModelEntry {
  id: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  provider?: {
    npm?: string;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Provider SDK creation
// ---------------------------------------------------------------------------

function createProviderSDK(npm: string, baseUrl: string, apiKey: string) {
  switch (npm) {
    case "@ai-sdk/anthropic":
      return createAnthropic({
        baseURL: baseUrl,
        apiKey,
      });

    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return createGoogleGenerativeAI({
        baseURL: baseUrl,
        apiKey,
      });

    case "@ai-sdk/moonshotai":
      return createMoonshotAI({
        baseURL: baseUrl,
        apiKey,
      });

    default:
      return createOpenAICompatible({
        baseURL: baseUrl,
        apiKey: apiKey || "not-needed",
        name: "openai-compatible",
        includeUsage: true,
      });
  }
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

/** SDKs keyed by providerId */
const providers = new Map<string, ReturnType<typeof createProviderSDK>>();

/** SDKs keyed by `${providerId}:${npm}` for per-model npm overrides */
const providerSdks = new Map<string, ReturnType<typeof createProviderSDK>>();

/** Provider config for baseUrl and apiKey */
const providerConfig = new Map<
  string,
  { baseUrl: string; apiKey: string; npm: string }
>();

/** Model → provider mapping */
const modelToProvider = new Map<string, string>();

/** Model metadata from provider-data.json */
const modelMetadata = new Map<string, ModelEntry>();

/** Bare model name → full registered model ID (for HF-style IDs like "Qwen/Qwen3.5") */
const bareNameToFullId = new Map<string, string>();

export let initialized = false;

// Build reverse index: env var → provider IDs
const envVarToProviders = new Map<string, string[]>();
for (const [providerId, entry] of Object.entries(providerData) as [
  string,
  ProviderEntry,
][]) {
  for (const envVar of entry.env) {
    if (!envVarToProviders.has(envVar)) {
      envVarToProviders.set(envVar, []);
    }
    envVarToProviders.get(envVar)?.push(providerId);
  }
}

// Env var aliases: ZEN_API_KEY maps to OPENCODE_API_KEY in provider-data.json
const ENV_KEY_ALIASES: Record<string, string> = {
  ZEN_API_KEY: "OPENCODE_API_KEY",
};

/**
 * Get API key for a provider, checking aliases.
 */
function getApiKey(envVar: string): string | undefined {
  const key = Bun.env[envVar];
  if (key) return key;

  const alias = ENV_KEY_ALIASES[envVar];
  if (alias) {
    return Bun.env[alias];
  }

  for (const [aliasName, targetVar] of Object.entries(ENV_KEY_ALIASES)) {
    if (targetVar === envVar && Bun.env[aliasName]) {
      return Bun.env[aliasName];
    }
  }

  return undefined;
}

/**
 * Get or create an SDK for a (providerId, npm) combination.
 */
function getOrCreateSDK(
  providerId: string,
  npm: string,
): ReturnType<typeof createProviderSDK> | undefined {
  const key = `${providerId}:${npm}`;

  // Check if we already have this SDK
  const existing = providerSdks.get(key);
  if (existing) return existing;

  // Get provider config
  const config = providerConfig.get(providerId);
  if (!config) return undefined;

  // Create new SDK with this npm type
  const sdk = createProviderSDK(npm, config.baseUrl, config.apiKey);
  providerSdks.set(key, sdk);
  return sdk;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize providers from configured API keys and base URLs.
 * Call once at server boot.
 */
export async function initProviderRegistry(): Promise<void> {
  // --- Local providers (vLLM, Ollama) ---
  const vllmBaseUrl = Bun.env.VLLM_BASE_URL;
  let ollamaBaseUrl = Bun.env.OLLAMA_BASE_URL;

  // Use SMALL_MODEL_BASE_URL for Ollama if SMALL_MODEL_PROVIDER_TYPE=ollama
  if (config.smallModel.providerType === "ollama" && !ollamaBaseUrl) {
    ollamaBaseUrl = config.smallModel.baseUrl;
  }

  if (vllmBaseUrl) {
    const sdk = createProviderSDK(
      "@ai-sdk/openai",
      `${vllmBaseUrl}/v1`,
      "not-needed",
    );
    providers.set("vllm", sdk);
    providerSdks.set("vllm:@ai-sdk/openai", sdk);
    providerConfig.set("vllm", {
      baseUrl: vllmBaseUrl,
      apiKey: "",
      npm: "@ai-sdk/openai",
    });
    log.info({ baseUrl: vllmBaseUrl }, "vllm provider initialized");

    const models = await fetchModels(`${vllmBaseUrl}/v1/models`);
    for (const modelId of models) {
      modelToProvider.set(modelId, "vllm");
    }
    log.info({ count: models.length }, "vllm models indexed");
  }

  if (ollamaBaseUrl) {
    const sdk = createProviderSDK(
      "@ai-sdk/openai",
      `${ollamaBaseUrl}/v1`,
      "not-needed",
    );
    providers.set("ollama", sdk);
    providerSdks.set("ollama:@ai-sdk/openai", sdk);
    providerConfig.set("ollama", {
      baseUrl: ollamaBaseUrl,
      apiKey: "",
      npm: "@ai-sdk/openai",
    });
    log.info({ baseUrl: ollamaBaseUrl }, "ollama provider initialized");

    const models = await fetchModels(`${ollamaBaseUrl}/v1/models`);
    for (const modelId of models) {
      modelToProvider.set(modelId, "ollama");
    }
    log.info({ count: models.length }, "ollama models indexed");
  }

  // --- Featherless (unlimited tokens, no logging, OpenAI-compatible) ---
  const featherlessBaseUrl = Bun.env.FEATHERLESS_BASE_URL;
  const featherlessApiKey = Bun.env.FEATHERLESS_API_KEY;
  if (featherlessBaseUrl && featherlessApiKey) {
    const sdk = createProviderSDK(
      "@ai-sdk/openai-compatible",
      featherlessBaseUrl,
      featherlessApiKey,
    );
    providers.set("featherless", sdk);
    providerSdks.set("featherless:@ai-sdk/openai-compatible", sdk);
    providerConfig.set("featherless", {
      baseUrl: featherlessBaseUrl,
      apiKey: featherlessApiKey,
      npm: "@ai-sdk/openai-compatible",
    });

    // Register the configured model — both the full HuggingFace ID and
    // a featherless/ prefixed version so resolution works either way.
    // The slash in HF model IDs (e.g. "Qwen/Qwen3.5-397B-A17B") conflicts
    // with the provider-prefix convention ("provider/model"), so we also
    // register the bare name after the slash for fallback resolution.
    const featherlessModel =
      Bun.env.FEATHERLESS_MODEL ?? "Qwen/Qwen3.5-397B-A17B";
    modelToProvider.set(featherlessModel, "featherless");
    // Also register the part after the slash so "Qwen3.5-397B-A17B" resolves
    if (featherlessModel.includes("/")) {
      const bareName = featherlessModel.split("/").pop() ?? "";
      modelToProvider.set(bareName, "featherless");
    }
    log.info(
      { baseUrl: featherlessBaseUrl, model: featherlessModel },
      "featherless provider initialized",
    );
  }

  // --- Remote providers (from provider-data.json) ---
  for (const [envVar, providerIds] of envVarToProviders) {
    const apiKey = getApiKey(envVar);
    if (!apiKey) continue;

    for (const providerId of providerIds) {
      const entry = (providerData as Record<string, ProviderEntry>)[providerId];
      if (!entry) continue;

      const baseUrl = entry.api ?? `https://${providerId}.example.com/v1`;
      const npm = entry.npm ?? "@ai-sdk/openai-compatible";
      const sdk = createProviderSDK(npm, baseUrl, apiKey);

      providers.set(providerId, sdk);
      providerSdks.set(`${providerId}:${npm}`, sdk);
      providerConfig.set(providerId, { baseUrl, apiKey, npm });

      for (const [modelId, meta] of Object.entries(entry.models || {})) {
        modelToProvider.set(modelId, providerId);
        modelMetadata.set(modelId, meta as ModelEntry);

        // For HuggingFace-style IDs (e.g., "Qwen/Qwen3.5-397B-A17B-TEE"),
        // also register the bare name (after the slash) for easier lookup.
        // This allows requesting "chutes/Qwen3.5-397B-A17B" to work.
        if (modelId.includes("/")) {
          const bareName = modelId.split("/").pop() ?? "";
          modelToProvider.set(bareName, providerId);
          modelMetadata.set(bareName, meta as ModelEntry);
          // Store mapping from bare name to full registered ID
          bareNameToFullId.set(bareName, modelId);
        }
      }

      log.info(
        { providerId, modelCount: Object.keys(entry.models || {}).length },
        "provider initialized from provider-data",
      );
    }
  }

  initialized = true;
  log.info(
    { providers: providers.size, models: modelToProvider.size },
    "provider registry initialized",
  );
}

/**
 * Fetch model IDs from an OpenAI-compatible /models endpoint.
 */
async function fetchModels(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      log.warn({ url, status: res.status }, "/models returned error");
      return [];
    }

    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return body.data?.map((m) => m.id) ?? [];
  } catch (err) {
    log.warn({ err, url }, "/models fetch failed");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a provider is initialized.
 */
export function hasProvider(providerId: string): boolean {
  return providers.has(providerId);
}

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
    const config = providerConfig.get(providerId);
    if (config?.npm) {
      return config.npm;
    }
  }

  return "@ai-sdk/openai-compatible";
}

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
    // For providers with HuggingFace-style model IDs, the API expects
    // the full "Org/Model" name. Reconstruct it from the registered ID.
    const fullRegisteredId = bareNameToFullId.get(bareModelId);
    const apiModelId = fullRegisteredId ?? bareModelId;
    const npm = getModelNpm(bareModelId);
    const sdk = getOrCreateSDK(providerId, npm);
    if (sdk) {
      return sdk.languageModel(apiModelId);
    }
    // Fall back to default SDK
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
 * Check if a model is registered.
 */
export function hasModel(modelId: string): boolean {
  const bareId = modelId.includes("/")
    ? (modelId.split("/")[1] ?? modelId)
    : modelId;
  return modelToProvider.has(bareId) || modelToProvider.has(modelId);
}

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
 * For local models, this looks up the model ID (typically from huggingface provider)
 * to get context window and other metadata.
 */
export function getEmbeddingModelMetadata(
  modelId: string,
): ModelEntry | undefined {
  // Normalize: try exact match, then case-insensitive, then without prefix
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

/**
 * Resolve embedding model for local inference.
 * Uses EMBED_BASE_URL/OLLAMA_BASE_URL for the endpoint (OpenAI-compatible).
 */
export function resolveEmbeddingModel(): EmbeddingModel {
  const embedModel =
    Bun.env.EMBED_MODEL ?? Bun.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b";
  const embedBaseUrl =
    Bun.env.EMBED_BASE_URL ??
    Bun.env.OLLAMA_BASE_URL ??
    "http://ollama.spark.lan";
  const embedApiKey = Bun.env.EMBED_API_KEY ?? "";

  // Create OpenAI-compatible provider for local endpoint
  const provider = createProviderSDK(
    "@ai-sdk/openai",
    `${embedBaseUrl}/v1`,
    embedApiKey || "not-needed",
  );

  return provider.embeddingModel(embedModel);
}

/**
 * Fetch model ID from a local /models endpoint.
 * Used to discover what model is actually running on a local server.
 */
export async function fetchModelId(baseUrl: string): Promise<string | null> {
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

  // Return first model (most local servers run one model)
  return models[0] ?? null;
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
 * Resolve the small model configuration.
 * If SMALL_MODEL_PROVIDER_TYPE is set, uses config directly (self-hosted).
 * Otherwise, falls through to the provider registry lookup.
 */
export function getSmallModelConfig(): {
  baseUrl: string;
  apiKey: string;
  model: string;
} | null {
  const { providerType, baseUrl, apiKey, model } = config.smallModel;

  if (providerType) {
    // Self-hosted: config has everything we need
    const normalizedBase = baseUrl.replace(/\/v1$/, "");
    return { baseUrl: normalizedBase, apiKey, model };
  }

  // Registry path: look up model in provider-data.json
  const providerCfg = getProviderConfigForModel(model);
  if (!providerCfg) {
    log.warn({ model }, "no provider found for small model");
    return null;
  }

  const normalizedBase = providerCfg.baseUrl.replace(/\/v1$/, "");
  return { baseUrl: normalizedBase, apiKey: providerCfg.apiKey, model };
}

/**
 * Check if the registry has been initialized.
 */
export function isRegistryReady(): boolean {
  return initialized;
}
