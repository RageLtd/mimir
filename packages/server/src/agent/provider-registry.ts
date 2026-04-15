/**
 * Provider registry — re-exports from agent-loop/provider.
 *
 * Thin wrapper to maintain the import structure
 * specified in the v2 architecture.
 */

export {
  defaultModel,
  embeddingModel,
  getReasoningOptions,
  getSamplingOptions,
  isMistralModel,
  ollama,
  resolveModel,
  vllm,
} from "../agent-loop/provider/model";

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
} from "../agent-loop/provider/query";

export {
  initProviderRegistry,
  type ModelEntry,
  type ProviderEntry,
} from "../agent-loop/provider/registry";
