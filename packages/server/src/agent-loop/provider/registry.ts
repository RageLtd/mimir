/**
 * Provider registry — state, SDK creation, and initialization.
 *
 * All behavior is driven by provider-data.json:
 *   - `npm` field determines which AI SDK factory creates the provider
 *   - `env` field determines which API key env var gates the provider
 *   - `api` field gives the base URL
 *   - `models` are indexed for resolution
 *
 * Local providers (vLLM, Ollama, Featherless) use the same registration
 * helpers but discover models dynamically from /models endpoints.
 *
 * Query functions (resolveModel, getModelMetadata, etc.) live in ./query.ts.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";

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
// Provider SDK creation — npm field from provider-data.json picks the factory
// ---------------------------------------------------------------------------

export function createProviderSDK(
  npm: string,
  baseUrl: string,
  apiKey: string,
) {
  switch (npm) {
    case "@ai-sdk/anthropic":
      return createAnthropic({ baseURL: baseUrl, apiKey });

    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return createGoogleGenerativeAI({ baseURL: baseUrl, apiKey });

    case "@ai-sdk/moonshotai":
      return createMoonshotAI({ baseURL: baseUrl, apiKey });

    case "@ai-sdk/openai":
      return createOpenAI({ baseURL: baseUrl, apiKey: apiKey || "not-needed" });

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

// ---------------------------------------------------------------------------
// Env var resolution
// ---------------------------------------------------------------------------

// ZEN_API_KEY maps to OPENCODE_API_KEY in provider-data.json
const ENV_KEY_ALIASES: Record<string, string> = {
  ZEN_API_KEY: "OPENCODE_API_KEY",
};

function getApiKey(envVar: string) {
  const key = Bun.env[envVar];
  if (key) return key;

  const alias = ENV_KEY_ALIASES[envVar];
  if (alias) return Bun.env[alias];

  for (const [aliasName, targetVar] of Object.entries(ENV_KEY_ALIASES)) {
    if (targetVar === envVar && Bun.env[aliasName]) return Bun.env[aliasName];
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// SDK cache for per-model npm overrides
// ---------------------------------------------------------------------------

export function getOrCreateSDK(
  providerId: string,
  npm: string,
) {
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
// Registration helpers
// ---------------------------------------------------------------------------

function registerProvider(
  id: string,
  npm: string,
  baseUrl: string,
  apiKey: string,
) {
  const sdk = createProviderSDK(npm, baseUrl, apiKey);
  providers.set(id, sdk);
  providerSdks.set(`${id}:${npm}`, sdk);
  providerConfig.set(id, { baseUrl, apiKey, npm });
  return sdk;
}

function registerModels(
  providerId: string,
  models: Record<string, ModelEntry>,
) {
  for (const [modelId, meta] of Object.entries(models)) {
    modelToProvider.set(modelId, providerId);
    modelMetadata.set(modelId, meta);

    if (modelId.includes("/")) {
      const bareName = modelId.split("/").pop() ?? "";
      modelToProvider.set(bareName, providerId);
      modelMetadata.set(bareName, meta);
      bareNameToFullId.set(bareName, modelId);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initProviderRegistry() {
  const raw = await Bun.file(PROVIDER_DATA_PATH).text();
  providerData = JSON.parse(raw) as Record<string, ProviderEntry>;

  // Build reverse index: env var → provider IDs
  const envVarToProviders = new Map<string, string[]>();
  for (const [providerId, entry] of Object.entries(providerData) as [
    string,
    ProviderEntry,
  ][]) {
    for (const envVar of entry.env) {
      if (!envVarToProviders.has(envVar)) envVarToProviders.set(envVar, []);
      envVarToProviders.get(envVar)?.push(providerId);
    }
  }

  // --- Local providers ---
  const vllmBaseUrl = Bun.env.VLLM_BASE_URL;
  if (vllmBaseUrl) {
    registerProvider("vllm", "@ai-sdk/openai", `${vllmBaseUrl}/v1`, "not-needed");
    const models = await fetchModels(`${vllmBaseUrl}/v1/models`);
    for (const id of models) modelToProvider.set(id, "vllm");
    log.info({ baseUrl: vllmBaseUrl, count: models.length }, "vllm initialized");
  }

  let ollamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
  if (config.smallModel.providerType === "ollama" && !ollamaBaseUrl) {
    ollamaBaseUrl = config.smallModel.baseUrl;
  }
  if (ollamaBaseUrl) {
    registerProvider("ollama", "@ai-sdk/openai", `${ollamaBaseUrl}/v1`, "not-needed");
    const models = await fetchModels(`${ollamaBaseUrl}/v1/models`);
    for (const id of models) modelToProvider.set(id, "ollama");
    log.info({ baseUrl: ollamaBaseUrl, count: models.length }, "ollama initialized");
  }

  // --- Remote providers (from provider-data.json) ---
  for (const [envVar, providerIds] of envVarToProviders) {
    const apiKey = getApiKey(envVar);
    if (!apiKey) continue;

    for (const providerId of providerIds) {
      const entry = providerData[providerId];
      if (!entry) continue;

      const baseUrl = entry.api ?? `https://${providerId}.example.com/v1`;
      const npm = entry.npm ?? "@ai-sdk/openai-compatible";
      registerProvider(providerId, npm, baseUrl, apiKey);
      registerModels(providerId, entry.models || {});

      log.info(
        { providerId, modelCount: Object.keys(entry.models || {}).length },
        "provider initialized",
      );
    }
  }

  initialized = true;
  log.info(
    { providers: providers.size, models: modelToProvider.size },
    "provider registry initialized",
  );
}

// ---------------------------------------------------------------------------
// Model discovery for local providers
// ---------------------------------------------------------------------------

async function fetchModels(url: string) {
  const [err, res] = await attempt(() =>
    fetch(url, { signal: AbortSignal.timeout(10_000) }),
  );
  if (err) {
    log.warn({ err, url }, "/models fetch failed");
    return [];
  }
  if (!res.ok) {
    log.warn({ url, status: res.status }, "/models returned error");
    return [];
  }
  const [parseErr, body] = await attempt(
    () => res.json() as Promise<{ data?: Array<{ id: string }> }>,
  );
  if (parseErr) {
    log.warn({ err: parseErr, url }, "/models parse failed");
    return [];
  }
  return body.data?.map((m) => m.id) ?? [];
}
