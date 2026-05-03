/**
 * Model-capability cache for the Claude Code backend.
 *
 * Populated once at startup by `discoverCCModelsViaSdk()` after it receives
 * the SDK's `supportedModels()` response. Read synchronously by
 * `buildSdkOptions()` to shape the `thinking` config per model, and by
 * `config-options.ts` to build the backend-native thought-level selector.
 *
 * Keyed by the CLI alias (`"opus"`, `"sonnet"`, `"haiku"`, or whatever
 * the SDK's `supportedModels()` returns — currently `"default"`,
 * `"sonnet"`, `"haiku"`). Identical to the string passed through as
 * `Options.model`.
 *
 * Lookup falls back through three passes so user-extras (like
 * `opus-4-6`, `claude-opus-4-7`, `opusplan`) inherit capabilities from
 * the matching SDK base alias:
 *   1. Direct hit on the cache, after stripping `[...]` variant suffix.
 *   2. Family detection from the alias string (substring "opus" / "sonnet"
 *      / "haiku" or specific aliases like `opusplan` → opus).
 *   3. Try each known SDK base alias for that family in order.
 *
 * Without this, mirror-aliases for current models would render with no
 * thought-level selector even though they're identical capability-wise
 * to the SDK's curated entry.
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

const stripVariantSuffix = (alias: string) => alias.replace(/\[.*\]$/, "");

/**
 * Family-fallback table: when a direct cache lookup misses, try these
 * SDK aliases in order for the detected family. The SDK currently
 * returns `default` for the latest opus, but historically used `opus`
 * — both are listed so the lookup is robust to either. Sonnet and
 * Haiku families currently have one canonical alias each.
 */
const FAMILY_FALLBACK_ALIASES: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ["opus", ["opus", "default"]],
    ["sonnet", ["sonnet"]],
    ["haiku", ["haiku"]],
  ],
);

/**
 * Detect the model family from an alias string. Matches against known
 * Anthropic family names plus the `opusplan` hybrid alias (which uses
 * Opus during plan mode and Sonnet for execution — its capability
 * profile mirrors Opus, since plan-mode reasoning is the controlling
 * factor for effort levels).
 */
const familyOf = (alias: string) => {
  if (alias === "opusplan") return "opus";
  const lower = alias.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return undefined;
};

/**
 * Resolve the cached `Capability` for an alias, with family fallback
 * for user-extras (`opus-4-6`, `claude-opus-4-7`, etc.) that inherit
 * from the SDK's base aliases.
 */
const capabilityFor = (alias: string) => {
  const direct = capabilities.get(stripVariantSuffix(alias));
  if (direct) return direct;
  const family = familyOf(alias);
  if (!family) return undefined;
  for (const fallback of FAMILY_FALLBACK_ALIASES.get(family) ?? []) {
    const cap = capabilities.get(fallback);
    if (cap) return cap;
  }
  return undefined;
};

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
export const supportsAdaptiveThinking = (modelAlias: string | undefined) => {
  if (!modelAlias) return undefined;
  return capabilityFor(modelAlias)?.supportsAdaptiveThinking;
};

/**
 * Return the effort levels declared as supported by the model.
 *
 * - Non-empty array — use these as the thought-level selector options.
 * - Empty array / `undefined` — the model didn't advertise effort support,
 *   and the caller should omit the thought-level selector entirely.
 */
export const supportedEffortLevels = (modelAlias: string | undefined) => {
  if (!modelAlias) return [] as readonly EffortLevel[];
  return capabilityFor(modelAlias)?.supportedEffortLevels ?? [];
};

/** Test helper — clears the module-level cache between cases. */
export const resetModelCapabilitiesForTests = () => {
  capabilities.clear();
};
