/**
 * Model-capability cache for the Claude Code backend.
 *
 * Populated once at startup by `discoverCCModelsViaSdk()` after it receives
 * the SDK's `supportedModels()` response. Read synchronously by
 * `buildSdkOptions()` to shape the `thinking` config per model, and by
 * `config-options.ts` to build the backend-native thought-level selector.
 *
 * Keyed by the CLI alias (`"opus"`, `"sonnet"`, `"haiku"`) — identical to
 * the string passed through as `Options.model`. Bracketed context variants
 * like `"opus[1m]"` share the capability of the base alias, so lookup
 * strips any `[...]` suffix before matching.
 */

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

type Capability = {
  readonly supportsAdaptiveThinking: boolean;
  readonly supportedEffortLevels: readonly EffortLevel[];
};

const capabilities = new Map<string, Capability>();

export const setModelCapabilities = (
  models: readonly {
    value: string;
    supportsAdaptiveThinking?: boolean;
    supportedEffortLevels?: readonly EffortLevel[];
  }[],
) => {
  capabilities.clear();
  for (const m of models) {
    capabilities.set(m.value, {
      supportsAdaptiveThinking: m.supportsAdaptiveThinking === true,
      supportedEffortLevels: m.supportedEffortLevels ?? [],
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

/**
 * Return the effort levels declared as supported by the model.
 *
 * - Non-empty array — use these as the thought-level selector options.
 * - Empty array / `undefined` — the model didn't advertise effort support,
 *   and the caller should omit the thought-level selector entirely.
 */
export const supportedEffortLevels = (
  modelAlias: string | undefined,
): readonly EffortLevel[] => {
  if (!modelAlias) return [];
  return (
    capabilities.get(stripVariantSuffix(modelAlias))?.supportedEffortLevels ??
    []
  );
};

/** Test helper — clears the module-level cache between cases. */
export const resetModelCapabilitiesForTests = () => {
  capabilities.clear();
};
