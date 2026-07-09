/**
 * Provider engine barrel — registry, query, and provider-data lifecycle.
 * Relocated from mimir-server's agent/provider (MIM-89).
 */

export {
  DEFAULT_PROVIDER_DATA_URL,
  getProviderData,
  loadProviderData,
  setProviderDataUrl,
  startProviderDataRefresh,
  stopProviderDataRefresh,
} from "./provider-data";
export {
  getContextWindow,
  getModelDisplayName,
  getModelMetadata,
  getModelNpm,
  getModelProvider,
  getProviderConfigForModel,
  getProviderDisplayName,
  getProviderEnvVar,
  getReasoningOptions,
  hasModel,
  hasProvider,
  isRegistryReady,
  listModels,
  listProviders,
  resolveModel,
  resolveModelWithOverride,
} from "./query";
export {
  createProviderSDK,
  initProviderRegistry,
  isSdkNativeNpm,
  type ModelEntry,
  type ProviderEntry,
  // Registry state map — exposed for tests that seed catalogue fixtures.
  providerModels,
  type RegistryOptions,
  SDK_NATIVE_NPMS,
} from "./registry";
