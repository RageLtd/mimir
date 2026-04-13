/**
 * Provider module — LLM provider setup, registry, and model routing.
 *
 * Re-exports from registry, model, and middleware submodules.
 * model.ts re-exports key registry functions, so consumers can
 * import everything from this single entry point.
 */

// Middleware — Mistral tool call streaming fix
export { mistralToolCallMiddleware } from "./mistral-middleware";

// Model — vLLM, Ollama, embedding, reasoning/sampling options
// Also re-exports: getContextWindow, getModelMetadata, getModelNpm,
// getModelProvider, hasModel, hasProvider from registry
export {
  defaultModel,
  embeddingModel,
  getContextWindow,
  getModelMetadata,
  getModelNpm,
  getModelProvider,
  getReasoningOptions,
  getSamplingOptions,
  hasModel,
  hasProvider,
  isMistralModel,
  ollama,
  resolveModel,
  vllm,
} from "./model";
// Registry — provider initialization, model resolution, metadata
export {
  fetchModelId,
  getEmbeddingModelMetadata,
  getProviderConfigForModel,
  initProviderRegistry,
  isRegistryReady,
  listModels,
  listProviders,
  type ModelEntry,
  type ProviderEntry,
  resolveEmbeddingModel,
  resolveModel as resolveRegistryModel,
} from "./registry";
