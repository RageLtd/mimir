/**
 * Provider registry — re-exports from agent-loop/provider.
 *
 * This is a thin wrapper to maintain the import structure
 * specified in the v2 architecture.
 */

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
} from "../agent-loop/provider/model";

export {
  fetchModelId,
  getProviderConfigForModel,
  initProviderRegistry,
  isRegistryReady,
  listModels,
  listProviders,
  type ModelEntry,
  type ProviderEntry,
} from "../agent-loop/provider/registry";
