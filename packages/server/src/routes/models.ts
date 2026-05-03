/**
 * Routes: GET /v1/models
 *
 * Model registry endpoint — returns local model + Zen + OpenRouter + provider registry models.
 * This is a thin wrapper around the existing listModels() function.
 */

import { Hono } from "hono";
import { listModels } from "../agent/provider-registry";
import {
  getModelDisplayName,
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
      part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : "",
    )
    .join(" ");

/**
 * Augment a raw `ModelEntry` with `display_name` / `provider_name` from
 * provider-data lookups. Pure function — passes the entry through
 * unchanged when no enrichments are available.
 */
const enrichEntry = (entry: ModelEntry): ModelEntry => {
  const display_name = getModelDisplayName(entry.id);
  const provider_name =
    getProviderDisplayName(entry.owned_by) ??
    titlecaseProviderId(entry.owned_by);
  return {
    ...entry,
    ...(display_name ? { display_name } : {}),
    ...(provider_name ? { provider_name } : {}),
  };
};

// Zen model list cache (refreshed every 5 minutes)
let zenModelsCache: ModelEntry[] = [];
let zenModelsCacheTime = 0;
const ZEN_CACHE_TTL = 5 * 60 * 1000;

async function getZenModels(): Promise<ModelEntry[]> {
  if (!config.zen.apiKey) return [];
  if (Date.now() - zenModelsCacheTime < ZEN_CACHE_TTL) return zenModelsCache;

  const [err, res] = await attempt(() =>
    fetch(`${config.zen.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.zen.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.json() as Promise<{ data: ModelEntry[] }>),
  );

  if (!err && res?.data) {
    zenModelsCache = res.data;
    zenModelsCacheTime = Date.now();
  }

  return zenModelsCache;
}

// OpenRouter model list cache (refreshed every 5 minutes)
let orModelsCache: ModelEntry[] = [];
let orModelsCacheTime = 0;

async function getOpenRouterModels(): Promise<ModelEntry[]> {
  if (!config.openrouter.apiKey) return [];
  if (Date.now() - orModelsCacheTime < ZEN_CACHE_TTL) return orModelsCache;

  const [err, res] = await attempt(() =>
    fetch(`${OPENROUTER_API_URL}/models`, {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    }).then(
      (r) =>
        r.json() as Promise<{ data: Array<{ id: string; created?: number }> }>,
    ),
  );

  if (!err && res?.data) {
    const now = Math.floor(Date.now() / 1000);
    orModelsCache = res.data.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created ?? now,
      owned_by: "openrouter",
    }));
    orModelsCacheTime = Date.now();
  }

  return orModelsCache;
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

models.get("/v1/models", async (c) => {
  const now = Math.floor(Date.now() / 1000);

  // Local model
  const local: ModelEntry = {
    id: config.vllm.model,
    object: "model",
    created: now,
    owned_by: "mimir",
  };

  // Fetch remote model lists in parallel
  const [zenModels, orModels] = await Promise.all([
    getZenModels(),
    getOpenRouterModels(),
  ]);

  // Add provider registry models (chutes, opencode, etc.). Skip
  // `opencode-go` entries when ZEN_GO_ENABLED is false — Go models share
  // OPENCODE_API_KEY with regular Zen models, so the registry initialises
  // them whenever the key is present; users without a Go subscription
  // need to opt out explicitly.
  const registryModels: ModelEntry[] = [];
  const allModels = listModels();
  for (const { modelId, providerId } of allModels) {
    if (providerId === "opencode-go" && !config.zen.goEnabled) continue;
    registryModels.push({
      id: modelId,
      object: "model",
      created: now,
      owned_by: providerId,
    });
  }

  // Enrich every entry with `display_name` / `provider_name` so ACP
  // clients can render `"<Friendly Name> (<Provider>)"` without their own
  // provider-data lookup.
  const data = [local, ...zenModels, ...orModels, ...registryModels].map(
    enrichEntry,
  );

  return c.json({ object: "list", data });
});
