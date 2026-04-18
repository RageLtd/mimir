/**
 * Model-capability cache for the Claude Code backend.
 *
 * Populated once at startup by `discoverCCModelsViaSdk()` after it receives
 * the SDK's `supportedModels()` response. Read synchronously by
 * `buildSdkOptions()` to shape the `thinking` config per model — adaptive
 * mode for capable models (Opus 4.7, Opus 4.6, Sonnet 4.6, Mythos), enabled
 * mode for older ones that still require a fixed `budgetTokens`.
 *
 * Keyed by the CLI alias (`"opus"`, `"sonnet"`, `"haiku"`) — identical to
 * the string passed through as `Options.model`. Bracketed context variants
 * like `"opus[1m]"` share the capability of the base alias, so lookup
 * strips any `[...]` suffix before matching.
 */

type Capability = {
  readonly supportsAdaptiveThinking: boolean;
};

const capabilities = new Map<string, Capability>();

export const setModelCapabilities = (
  models: readonly {
    value: string;
    supportsAdaptiveThinking?: boolean;
  }[],
) => {
  capabilities.clear();
  for (const m of models) {
    capabilities.set(m.value, {
      supportsAdaptiveThinking: m.supportsAdaptiveThinking === true,
    });
  }
};

const stripVariantSuffix = (alias: string): string =>
  alias.replace(/\[.*\]$/, "");

/**
 * Look up whether a model alias supports adaptive thinking.
 *
 * - `true` — capability confirmed by the SDK.
 * - `false` — model is in the catalogue but does not support adaptive.
 * - `undefined` — no data (discovery hasn't run or alias absent from catalogue).
 *
 * Callers treat `undefined` as a decision point. `buildSdkOptions` defaults
 * to adaptive mode on `undefined` because the current Anthropic catalogue
 * is overwhelmingly adaptive-capable and the unknown-model case most
 * commonly arises from a model the SDK added after the catalogue was last
 * fetched.
 */
export const supportsAdaptiveThinking = (
  modelAlias: string | undefined,
): boolean | undefined => {
  if (!modelAlias) return undefined;
  return capabilities.get(stripVariantSuffix(modelAlias))
    ?.supportsAdaptiveThinking;
};

/** Test helper — clears the module-level cache between cases. */
export const resetModelCapabilitiesForTests = () => {
  capabilities.clear();
};
