/**
 * Provider module — LLM provider setup, registry, and model routing.
 *
 * Re-exports from registry, query, model, and middleware submodules.
 */

// Middleware — Mistral tool call streaming fix
export { mistralToolCallMiddleware } from "./mistral-middleware";

// Model — vLLM, Ollama, embedding, reasoning/sampling options
export {
  defaultModel,
  embeddingModel,
  getReasoningOptions,
  getSamplingOptions,
  isMistralModel,
  ollama,
  vllm,
} from "./model";
// Query — model resolution, metadata lookup, provider config
export {
  fetchModelId,
  getContextWindow,
  getEmbeddingModelMetadata,
  getModelMetadata,
  getModelNpm,
  getModelProvider,
  getProviderConfigForModel,
  getSmallModelConfig,
  hasModel,
  hasProvider,
  isRegistryReady,
  listModels,
  listProviders,
  resolveEmbeddingModel,
  resolveModel,
} from "./query";
// Registry — state, SDK creation, initialization
export {
  initProviderRegistry,
  type ModelEntry,
  type ProviderEntry,
} from "./registry";
