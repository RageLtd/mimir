/**
 * Provider module — re-exports from registry, query, and middleware.
 */

export {
  fetchModelId,
  getContextWindow,
  getEmbeddingModelMetadata,
  getModelMetadata,
  getModelNpm,
  getModelProvider,
  getProviderConfigForModel,
  getReasoningOptions,
  getSmallModelConfig,
  hasModel,
  hasProvider,
  isRegistryReady,
  listModels,
  listProviders,
  resolveEmbeddingModel,
  resolveModel,
} from "./query";

export {
  initProviderRegistry,
  type ModelEntry,
  type ProviderEntry,
} from "./registry";
