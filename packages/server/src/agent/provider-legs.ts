/**
 * Server-only provider leg — the one piece that did NOT relocate with the
 * provider engine (MIM-89, engine now lives in @mimir/plugin-core).
 *
 * Embeddings are operator-pinned infrastructure (EMBED_* env), consumed by
 * goldfish retrieval which survives for the /mcp memory tools. This
 * deliberately does NOT consult the provider registry: the reduced server
 * runs no registry at all — the embedding endpoint is the operator's
 * choice, not a per-request model resolution.
 * (getSmallModelConfig died with routes/completions in the reduction.)
 */

import { createProviderSDK } from "@mimir/plugin-core/engine/provider";
import { config } from "../config";

export function resolveEmbeddingModel() {
  const { baseUrl, apiKey, model } = config.embedding;

  const provider = createProviderSDK(
    "@ai-sdk/openai",
    `${baseUrl}/v1`,
    apiKey || "not-needed",
  );

  return provider.embeddingModel(model);
}
