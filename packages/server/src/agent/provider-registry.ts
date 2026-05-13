/**
 * Provider registry — re-exports from agent-loop/provider.
 *
 * Thin wrapper to maintain the import structure
 * specified in the v2 architecture.
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
} from "../agent-loop/provider/query";

export {
  initProviderRegistry,
  type ModelEntry,
  type ProviderEntry,
} from "../agent-loop/provider/registry";
