/**
 * Routes: GET /v1/models
 *
 * Model registry endpoint — returns local model + Zen + OpenRouter + provider registry models.
 * This is a thin wrapper around the existing listModels() function.
 */

import { Hono } from "hono";
import { listModels } from "../agent/provider-registry";
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
}

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

  // Add provider registry models (chutes, opencode, etc.)
  const registryModels: ModelEntry[] = [];
  const allModels = listModels();
  for (const { modelId, providerId } of allModels) {
    registryModels.push({
      id: modelId,
      object: "model",
      created: now,
      owned_by: providerId,
    });
  }

  return c.json({
    object: "list",
    data: [local, ...zenModels, ...orModels, ...registryModels],
  });
});
