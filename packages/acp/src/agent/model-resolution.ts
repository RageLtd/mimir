/**
 * Model + config-option resolution for the ACP agent.
 *
 * Builds the `SessionModelState` Zed renders in its picker (including the
 * auto-select fallback when the configured default isn't in the discovered
 * list) and the backend-specific `SessionConfigOption[]` advertised on
 * session lifecycle events.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { BackendRouter } from "../backends";
import {
  buildCCConfigOptions,
  DEFAULT_CC_MODE,
} from "../backends/claude-code/config-options";
import type { MimirConfig } from "../config";
import {
  CC_PREFIX,
  fetchServerModels,
  isCCModel,
  mergeModels,
} from "../routing";
import { createChildLogger, log } from "../utils/log";
import type { SessionState } from "./types";

const logger = createChildLogger(log, "model-resolution");

export type ModelResolutionDeps = {
  readonly config: MimirConfig;
  readonly router: BackendRouter;
  readonly getDiscoveredCCModels: () => readonly acp.ModelInfo[];
  readonly getDiscoveredCopilotModels: () => readonly acp.ModelInfo[];
};

/**
 * Resolve the CLI alias for a CC-prefixed model id. Returns undefined for
 * non-CC models so callers can skip alias-dependent lookups.
 */
export const ccAliasFor = (modelId: string) =>
  modelId.startsWith(CC_PREFIX) ? modelId.slice(CC_PREFIX.length) : undefined;

/**
 * Assemble the merged model list and pick the current model id Zed should
 * render as selected.
 *
 * Resolution order for `currentModelId`:
 *   1. `preferredModelId` if it matches a discovered model — lets the session's
 *      live `currentModelId` (just-set or persisted) survive the round-trip
 *      so Zed's picker reflects the user's actual override instead of snapping
 *      back to the env-var default.
 *   2. `config.model` (from `MIMIR_MODEL`) if present in the merged list.
 *   3. First available entry — so the picker highlights something real when
 *      the configured default isn't in the discovered list (common when
 *      `MIMIR_MODEL` is unset and defaults to "openrouter/auto").
 *   4. The preferred or configured id as-is — preserves the value even when
 *      no models are discovered (e.g. all backends offline).
 */
export const buildModelsState = async (
  deps: ModelResolutionDeps,
  preferredModelId?: string,
) => {
  const { config, router } = deps;
  const serverModels = await fetchServerModels(config.serverUrl, config.apiKey);
  const ccModels = router.runtime.ccEnabled ? deps.getDiscoveredCCModels() : [];
  const copilotModels = router.runtime.copilotEnabled
    ? deps.getDiscoveredCopilotModels()
    : [];
  const availableModels = mergeModels(
    serverModels,
    [...ccModels],
    [...copilotModels],
  );
  const preferred = preferredModelId
    ? availableModels.find((m) => m.modelId === preferredModelId)
    : undefined;
  const configured = availableModels.find((m) => m.modelId === config.model);
  if (!preferred && !configured && availableModels.length > 0) {
    logger.info(
      `neither preferred "${preferredModelId ?? "<none>"}" nor configured ` +
        `"${config.model}" in discovered list; falling back to ` +
        `"${availableModels[0]?.modelId}"`,
    );
  }
  const currentModelId =
    preferred?.modelId ??
    configured?.modelId ??
    availableModels[0]?.modelId ??
    preferredModelId ??
    config.model;
  logger.debug(
    `buildModelsState: ${availableModels.length} models, current=${currentModelId} (preferred=${preferredModelId ?? "<none>"})`,
  );
  return { availableModels, currentModelId };
};

/**
 * Build a `"model"` category selector from the merged models list. Zed's
 * newer UI surfaces model selection through `configOptions` rather than the
 * legacy top-level `models` field — when any `configOptions` are present,
 * the model picker needs an entry here to render.
 */
export const buildModelConfigOption = (models: acp.SessionModelState) => ({
  type: "select" as const,
  id: "model",
  name: "Model",
  category: "model",
  currentValue: models.currentModelId,
  options: models.availableModels.map((m) => ({
    value: m.modelId,
    name: m.name ?? m.modelId,
    ...(m.description ? { description: m.description } : {}),
  })),
});

/**
 * Build the backend-native `configOptions[]` for the given session (mode +
 * thought-level). Does NOT include the model selector — that's composed by
 * the handler from `buildModelConfigOption` since it depends on the merged
 * models list.
 */
export const buildSessionConfigOptions = (
  deps: ModelResolutionDeps,
  session: SessionState,
) => {
  // Only the CC backend currently surfaces native config options. Inline
  // prefix + runtime check rather than calling `router.forModel`, which
  // throws when the matching backend is disabled — we'd just translate that
  // into "no options" anyway.
  if (!isCCModel(session.currentModelId)) return [];
  if (!deps.router.runtime.ccEnabled) return [];
  return buildCCConfigOptions({
    modelAlias: ccAliasFor(session.currentModelId),
    currentMode: session.currentMode || DEFAULT_CC_MODE,
    currentThoughtLevel: session.currentThoughtLevel,
    bypassPermissionsAllowed:
      deps.config.cc.permissionMode === "bypassPermissions",
  });
};

/**
 * Compose the full session-lifecycle response shape: the merged
 * `SessionModelState` plus the assembled `configOptions[]` (mode +
 * thought-level + model selector last).
 *
 * Threads `preferredModelId` through `buildModelsState` so the resulting
 * `currentValue` of the model selector reflects the session's actual
 * `currentModelId` (just-set or persisted) rather than snapping back to the
 * `MIMIR_MODEL` default. Without this, picking a model in Zed appears to
 * revert: `setModel` updates session state correctly, but the response
 * advertises the env-var default as `currentValue` and Zed's UI follows.
 */
export const composeSessionResponse = async (
  deps: ModelResolutionDeps,
  session: SessionState,
  preferredModelId?: string,
) => {
  const models = await buildModelsState(deps, preferredModelId).catch((err) => {
    logger.warn("buildModelsState failed:", err);
    return undefined;
  });
  const backendOptions = buildSessionConfigOptions(deps, session);
  const configOptions =
    models && models.availableModels.length > 0 && models.currentModelId
      ? [...backendOptions, buildModelConfigOption(models)]
      : backendOptions;
  return { models, configOptions };
};
