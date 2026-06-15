/**
 * Routes: GET /v1/models
 *
 * Model registry endpoint. Returns the optional local self-hosted model, the
 * provider registry's catalogue (provider-qualified ids, from
 * provider-data.json — includes OpenCode Zen + Go), and OpenRouter's filtered
 * list. Every model id is provider-qualified (e.g. "opencode-go/glm-5.1") so a
 * model offered by multiple providers stays separately selectable.
 */

import { Hono } from "hono";
import { listModels } from "../agent/provider-registry";
import {
  getModelDisplayName,
  getModelMetadata,
  getProviderDisplayName,
} from "../agent-loop/provider/query";
import { config, OPENROUTER_API_URL } from "../config";
import { attempt } from "../util/result";

export const models = new Hono();

// ---------------------------------------------------------------------------
// Model List Caching
// ---------------------------------------------------------------------------

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  /**
   * Human-readable model name from `provider-data.json` when available
   * (e.g. "Kimi K2.5"). ACP clients use this for the dropdown label;
   * absent → client falls back to `id`. Optional in the response since
   * Zen / OpenRouter / arbitrary upstreams don't carry it.
   */
  display_name?: string;
  /**
   * Human-readable provider name from `provider-data.json`'s top-level
   * `name` field (e.g. "OpenCode Go"). ACP clients display this in the
   * model selector parenthetical; absent → client titlecases `owned_by`.
   */
  provider_name?: string;
  /**
   * Whether the model supports extended thinking / reasoning. Derived
   * from `provider-data.json`'s per-model `reasoning` flag. ACP clients
   * use this to conditionally expose a thought-level config selector.
   */
  reasoning?: boolean;
}

/**
 * Convenience helper: titlecase an `owned_by` provider id when no
 * friendly name is registered in `provider-data.json`. Used by the
 * server's enrichment pass below; the ACP also has its own fallback,
 * but doing it here keeps the wire payload self-describing.
 */
const titlecaseProviderId = (id: string) =>
  id
    .split(/[-_]/g)
    .map((part) =>
      part.length > 0 ? part[0]?.toUpperCase() + part.slice(1) : "",
    )
    .join(" ");

/**
 * Strip the leading `${owned_by}/` provider qualifier from an entry's id to
 * recover the bare model id used as the key in provider-data lookups. Entries
 * are now listed provider-qualified (e.g. "opencode-go/glm-5.1"), but the
 * metadata maps are keyed by the bare model id ("glm-5.1"). Local entries
 * (owned_by "mimir") carry an unqualified id and pass through unchanged.
 */
export const bareModelId = (entry: Pick<ModelEntry, "id" | "owned_by">) =>
  entry.id.startsWith(`${entry.owned_by}/`)
    ? entry.id.slice(entry.owned_by.length + 1)
    : entry.id;

/**
 * Augment a raw `ModelEntry` with `display_name` / `provider_name` from
 * provider-data lookups. Pure function — passes the entry through
 * unchanged when no enrichments are available.
 */
const enrichEntry = (entry: ModelEntry) => {
  const lookupId = bareModelId(entry);
  const display_name = getModelDisplayName(lookupId);
  const provider_name =
    getProviderDisplayName(entry.owned_by) ??
    titlecaseProviderId(entry.owned_by);
  const meta = getModelMetadata(lookupId);
  return {
    ...entry,
    ...(display_name ? { display_name } : {}),
    ...(provider_name ? { provider_name } : {}),
    ...(meta?.reasoning ? { reasoning: true } : {}),
  };
};

// Remote model-list cache TTL. Only OpenRouter is fetched directly now — Zen
// (OpenCode) is served through the registry from provider-data.json, the same
// endpoint a direct fetch would hit, so a bespoke Zen fetch was pure
// duplication. OpenRouter stays direct because its ZDR / pricing / modality
// filtering relies on live OpenRouter API data that provider-data.json lacks.
const MODEL_CACHE_TTL = 5 * 60 * 1000;

// OpenRouter model list cache (refreshed every 5 minutes)
let orModelsCache: ModelEntry[] = [];
let orModelsCacheTime = 0;

/**
 * Fetch the set of model IDs that have at least one ZDR-compliant endpoint.
 * Returns undefined on failure so callers can fall back to the unfiltered list.
 */
async function fetchZdrModelIds() {
  const [err, res] = await attempt(() =>
    fetch(`${OPENROUTER_API_URL}/endpoints/zdr`, {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.json() as Promise<{ data: Array<{ model_id: string }> }>),
  );

  if (err || !res?.data) return undefined;
  return new Set(res.data.map((e) => e.model_id));
}

async function getOpenRouterModels(): Promise<ModelEntry[]> {
  if (!config.openrouter.apiKey) return [];
  if (Date.now() - orModelsCacheTime < MODEL_CACHE_TTL) return orModelsCache;

  // Fetch models and (when ZDR is enabled) ZDR endpoints in parallel
  const [modelsResult, zdrIds] = await Promise.all([
    attempt(() =>
      fetch(`${OPENROUTER_API_URL}/models`, {
        headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      }).then(
        (r) =>
          r.json() as Promise<{
            data: Array<{
              id: string;
              created?: number;
              pricing?: { prompt?: string; completion?: string };
              architecture?: { output_modalities?: string[] };
            }>;
          }>,
      ),
    ),
    config.openrouter.zdr ? fetchZdrModelIds() : undefined,
  ]);

  const [err, res] = modelsResult;
  if (!err && res?.data) {
    const now = Math.floor(Date.now() / 1000);
    let models = res.data;

    // Keep only models that produce text output — strips image generation,
    // audio-only, and embedding models from the coding agent's picker.
    models = models.filter(
      (m) => m.architecture?.output_modalities?.includes("text") ?? true,
    );

    // When ZDR is enabled and we got the endpoint list, keep only models
    // that have at least one ZDR-compliant endpoint.
    if (zdrIds) {
      models = models.filter((m) => zdrIds.has(m.id));
    }

    // When free-only is enabled, keep only models with zero-cost pricing.
    if (config.openrouter.freeOnly) {
      models = models.filter(
        (m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0",
      );
    }

    // Exclude model families whose upstream retention policies are unverifiable.
    // ZDR only covers the routing provider, not the model vendor behind it.
    const { excludePrefixes } = config.openrouter;
    if (excludePrefixes.length > 0) {
      models = models.filter(
        (m) => !excludePrefixes.some((prefix) => m.id.startsWith(prefix)),
      );
    }

    orModelsCache = models.map((m) => ({
      id: `openrouter/${m.id}`,
      object: "model",
      created: m.created ?? now,
      owned_by: "openrouter",
    }));
    orModelsCacheTime = Date.now();
  }

  return orModelsCache;
}

/**
 * The local self-hosted model entry, when one is configured. An empty
 * `vllmModel` (hosted-only deployments where `VLLM_MODEL=""`) yields no
 * entry rather than a blank-id model — a `{ id: "" }` entry sorts first in
 * the client picker and gets selected as the default, breaking model
 * selection. Exported for unit testing.
 */
export const buildLocalModels = (vllmModel: string, now: number) => {
  if (!vllmModel) return [];
  const local: ModelEntry = {
    id: vllmModel,
    object: "model",
    created: now,
    owned_by: "mimir",
  };
  return [local];
};

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

models.get("/v1/models", async (c) => {
  const now = Math.floor(Date.now() / 1000);

  // Local model — only advertised when a self-hosted model is configured.
  const localModels = buildLocalModels(config.vllm.model, now);

  // OpenRouter is the only direct fetch (filtered by ZDR/pricing/modality).
  const orModels = await getOpenRouterModels();

  // Provider registry models (chutes, opencode, opencode-go, ollama-cloud, …),
  // each emitted under a provider-qualified id so a model offered by several
  // providers stays separately selectable and round-trips through
  // `resolveModel`'s first-slash provider hint. Skips:
  //   - `opencode-go` when ZEN_GO_ENABLED is false (Go shares OPENCODE_API_KEY
  //     with regular Zen, so the registry initialises it whenever the key is
  //     present; non-subscribers opt out explicitly).
  //   - `openrouter`, whose entries come from `getOpenRouterModels` instead —
  //     the registry's copy is unfiltered and would bypass ZDR/pricing gates.
  const registryModels: ModelEntry[] = [];
  for (const { modelId, providerId } of listModels()) {
    if (providerId === "opencode-go" && !config.zen.goEnabled) continue;
    if (providerId === "openrouter") continue;
    registryModels.push({
      id: `${providerId}/${modelId}`,
      object: "model",
      created: now,
      owned_by: providerId,
    });
  }

  // Dedup by id (safety net — the qualified-id namespaces don't overlap) and
  // enrich every entry with `display_name` / `provider_name` so ACP clients can
  // render `"<Friendly Name> (<Provider>)"` without their own provider lookup.
  const seen = new Set<string>();
  const data = [...localModels, ...orModels, ...registryModels]
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .map(enrichEntry);

  return c.json({ object: "list", data });
});
