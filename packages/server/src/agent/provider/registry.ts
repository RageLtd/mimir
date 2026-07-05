/**
 * Provider registry — state, SDK creation, and initialization.
 *
 * All behavior is driven by the in-memory models.dev data (provider-data.ts):
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
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import { getProviderData } from "./provider-data";

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

/**
 * npm ids with an SDK-native factory case in createProviderSDK. These SDKs
 * carry their own default endpoints, so a models.dev entry with no `api`
 * URL is valid for them — the SDK default IS the contract (MIM-73/MIM-78).
 * Registration and BYOK consult this to decide between "register with
 * undefined baseUrl" and "refuse loudly". Lockstep with the switch below
 * is enforced by registry.test.ts.
 */
export const SDK_NATIVE_NPMS = [
  "@ai-sdk/anthropic",
  "@ai-sdk/cohere",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/moonshotai",
  "@ai-sdk/openai",
  "@openrouter/ai-sdk-provider",
] as const;

export function isSdkNativeNpm(npm: string) {
  return SDK_NATIVE_NPMS.some((native) => native === npm);
}

export function createProviderSDK(
  npm: string,
  // Undefined → the SDK's own default endpoint. Only SDK-native factories
  // have one; the openai-compatible fallback requires an explicit URL
  // (callers enforce this — see resolveModelWithOverride).
  baseUrl: string | undefined,
  apiKey: string,
) {
  // Spread-omit so SDK defaults apply when no URL is known — passing
  // `baseURL: undefined` explicitly is safe, but "" would break requests.
  const base = baseUrl ? { baseURL: baseUrl } : {};
  switch (npm) {
    case "@ai-sdk/anthropic":
      return createAnthropic({ ...base, apiKey });

    case "@ai-sdk/cohere":
      return createCohere({ ...base, apiKey });

    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return createGoogleGenerativeAI({ ...base, apiKey });

    case "@ai-sdk/moonshotai":
      return createMoonshotAI({ ...base, apiKey });

    case "@ai-sdk/openai":
      return createOpenAI({ ...base, apiKey: apiKey || "not-needed" });

    case "@openrouter/ai-sdk-provider":
      return createOpenRouter({
        ...base,
        apiKey,
        ...(config.openrouter.zdr
          ? { extraBody: { provider: { zdr: true } } }
          : {}),
      });

    default:
      // Generic OpenAI-compatible has no default endpoint — an explicit
      // URL is structural, not optional.
      if (!baseUrl) {
        throw new Error(
          `Provider SDK "${npm}" requires a base URL and none is known`,
        );
      }
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

/** Provider config for baseUrl and apiKey. baseUrl is undefined for
 * SDK-native providers whose models.dev entry has no `api` field — the
 * SDK default endpoint applies (MIM-78). */
export const providerConfig = new Map<
  string,
  { baseUrl: string | undefined; apiKey: string; npm: string }
>();

/** Model → provider mapping */
export const modelToProvider = new Map<string, string>();

/** Model metadata from provider-data.json */
export const modelMetadata = new Map<string, ModelEntry>();

/** Bare model name → full registered model ID (for HF-style IDs like "Qwen/Qwen3.5") */
export const bareNameToFullId = new Map<string, string>();

/**
 * Provider → its canonical model IDs. Unlike `modelToProvider` (which is keyed
 * by model ID and so collapses a model offered by several providers down to a
 * single winner), this index keeps every provider's full catalogue intact. It
 * is the source of truth for `listModels` / the picker, where a model served by
 * both OpenCode Zen and OpenCode Go must appear as two distinct, separately
 * selectable entries. Holds canonical IDs only — never bare-name aliases.
 */
export const providerModels = new Map<string, string[]>();

/** Append canonical model IDs to a provider's listing index, deduped. */
function addProviderModels(providerId: string, ids: string[]) {
  if (ids.length === 0) return;
  const merged = new Set(providerModels.get(providerId) ?? []);
  for (const id of ids) merged.add(id);
  providerModels.set(providerId, [...merged]);
}

export let initialized = false;

/** Runtime-loaded provider data — populated during initProviderRegistry(). */
export let providerData: Record<string, ProviderEntry> = {};

// ---------------------------------------------------------------------------
// SDK cache for per-model npm overrides
// ---------------------------------------------------------------------------

export function getOrCreateSDK(providerId: string, npm: string) {
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
  baseUrl: string | undefined,
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
  addProviderModels(providerId, Object.keys(models));
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
  // In-memory provider data (models.dev), loaded/refreshed by
  // provider-data.ts (MIM-65). Empty when the fetch has never succeeded —
  // remote providers sit out until the refresh loop lands; locals register
  // regardless.
  providerData = getProviderData();

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
    registerProvider(
      "vllm",
      "@ai-sdk/openai",
      `${vllmBaseUrl}/v1`,
      "not-needed",
    );
    const models = await fetchModels(`${vllmBaseUrl}/v1/models`);
    for (const id of models) modelToProvider.set(id, "vllm");
    addProviderModels("vllm", models);
    log.info(
      { baseUrl: vllmBaseUrl, count: models.length },
      "vllm initialized",
    );
  }

  let ollamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
  if (config.smallModel.providerType === "ollama" && !ollamaBaseUrl) {
    ollamaBaseUrl = config.smallModel.baseUrl;
  }
  if (ollamaBaseUrl) {
    registerProvider(
      "ollama",
      "@ai-sdk/openai",
      `${ollamaBaseUrl}/v1`,
      "not-needed",
    );
    const models = await fetchModels(`${ollamaBaseUrl}/v1/models`);
    for (const id of models) modelToProvider.set(id, "ollama");
    addProviderModels("ollama", models);
    log.info(
      { baseUrl: ollamaBaseUrl, count: models.length },
      "ollama initialized",
    );
  }

  // LM Studio — OpenAI-compatible local server. Routed through
  // `@ai-sdk/openai-compatible` per Vercel's documented integration: LM Studio
  // doesn't honour OpenAI's `reasoningEffort` shape, so the conservative SDK
  // is correct here. Models are whatever's currently loaded in the LM Studio
  // UI when this runs — restart to pick up newly loaded ones.
  let lmstudioBaseUrl = Bun.env.LMSTUDIO_BASE_URL;
  if (config.smallModel.providerType === "lmstudio" && !lmstudioBaseUrl) {
    lmstudioBaseUrl = config.smallModel.baseUrl;
  }
  if (lmstudioBaseUrl) {
    registerProvider(
      "lmstudio",
      "@ai-sdk/openai-compatible",
      `${lmstudioBaseUrl}/v1`,
      "not-needed",
    );
    const models = await fetchModels(`${lmstudioBaseUrl}/v1/models`);
    for (const id of models) modelToProvider.set(id, "lmstudio");
    addProviderModels("lmstudio", models);
    log.info(
      { baseUrl: lmstudioBaseUrl, count: models.length },
      "lmstudio initialized",
    );
  }

  // --- Remote providers (from provider-data.json) ---
  for (const [envVar, providerIds] of envVarToProviders) {
    const apiKey = Bun.env[envVar];
    if (!apiKey) continue;

    for (const providerId of providerIds) {
      const entry = providerData[providerId];
      if (!entry) continue;

      // models.dev omits `api` for SDK-native providers — their SDK's
      // default endpoint is the contract, so undefined passes through
      // (mirrors the BYOK path, MIM-73). Only the generic
      // openai-compatible fallback structurally needs a URL; without one,
      // skip loudly instead of registering models that can only fail at
      // call time (MIM-78: the old fabricated example.com URL turned a
      // set COHERE_API_KEY into 14 registered-but-broken models).
      const baseUrl = entry.api;
      const npm = entry.npm ?? "@ai-sdk/openai-compatible";
      if (!baseUrl && !isSdkNativeNpm(npm)) {
        log.warn(
          { providerId, npm },
          "provider has no API URL and no SDK-native factory — skipping registration",
        );
        continue;
      }
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
