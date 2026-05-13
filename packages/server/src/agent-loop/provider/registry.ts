/**
 * Provider registry — state, SDK creation, and initialization.
 *
 * At boot:
 *   1. Initialize providers for configured API keys (from provider-data.json)
 *   2. Initialize local providers (vLLM, Ollama) for configured base URLs
 *   3. Fetch models from local providers' /models endpoints
 *   4. Index all models: modelId → providerId, modelId → metadata
 *
 * Query functions (resolveModel, getModelMetadata, etc.) live in ./query.ts.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../../config";
import { log } from "../../util/logger";

const PROVIDER_DATA_PATH = "provider-data.json";

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

export function createProviderSDK(
  npm: string,
  baseUrl: string,
  apiKey: string,
) {
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

    case "@openrouter/ai-sdk-provider":
      return createOpenRouter({
        baseURL: baseUrl,
        apiKey,
        ...(config.openrouter.zdr
          ? { extraBody: { provider: { zdr: true } } }
          : {}),
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
// Registry state — exported for query.ts to read
// ---------------------------------------------------------------------------

/** SDKs keyed by providerId */
export const providers = new Map<
  string,
  ReturnType<typeof createProviderSDK>
>();

/** SDKs keyed by `${providerId}:${npm}` for per-model npm overrides */
export const providerSdks = new Map<
  string,
  ReturnType<typeof createProviderSDK>
>();

/** Provider config for baseUrl and apiKey */
export const providerConfig = new Map<
  string,
  { baseUrl: string; apiKey: string; npm: string }
>();

/** Model → provider mapping */
export const modelToProvider = new Map<string, string>();

/** Model metadata from provider-data.json */
export const modelMetadata = new Map<string, ModelEntry>();

/** Bare model name → full registered model ID (for HF-style IDs like "Qwen/Qwen3.5") */
export const bareNameToFullId = new Map<string, string>();

export let initialized = false;

/** Runtime-loaded provider data — populated during initProviderRegistry(). */
export let providerData: Record<string, ProviderEntry> = {};

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
export function getOrCreateSDK(
  providerId: string,
  npm: string,
): ReturnType<typeof createProviderSDK> | undefined {
  const key = `${providerId}:${npm}`;

  const existing = providerSdks.get(key);
  if (existing) return existing;

  const cfg = providerConfig.get(providerId);
  if (!cfg) return undefined;

  const sdk = createProviderSDK(npm, cfg.baseUrl, cfg.apiKey);
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
  // Load provider data from disk (freshly fetched from models.dev at boot)
  const raw = await Bun.file(PROVIDER_DATA_PATH).text();
  providerData = JSON.parse(raw) as Record<string, ProviderEntry>;

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
    const featherlessModel =
      Bun.env.FEATHERLESS_MODEL ?? "Qwen/Qwen3.5-397B-A17B";
    modelToProvider.set(featherlessModel, "featherless");
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

        if (modelId.includes("/")) {
          const bareName = modelId.split("/").pop() ?? "";
          modelToProvider.set(bareName, providerId);
          modelMetadata.set(bareName, meta as ModelEntry);
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
