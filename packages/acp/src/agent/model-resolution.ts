/**
 * Model + config-option resolution for the ACP agent.
 *
 * Builds the `SessionModelState` Zed renders in its picker (including the
 * auto-select fallback when the configured default isn't in the discovered
 * list) and the backend-specific `SessionConfigOption[]` advertised on
 * session lifecycle events.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { MimirConfig } from "../config";
import { fetchServerModels } from "../server-client";
import { createChildLogger, log } from "../utils/log";
import type { SessionState } from "./types";

const logger = createChildLogger(log, "model-resolution");

export type ModelResolutionDeps = {
  readonly config: MimirConfig;
  /**
   * Set of server-backend model IDs that support extended thinking /
   * reasoning. Populated by `buildModelsState` from the server's
   * `/v1/models` response; consumed by `buildSessionConfigOptions` to
   * expose a thought-level selector for reasoning-capable models.
   */
  serverReasoningModels: Set<string>;
};

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
  const { config } = deps;
  const serverResult = await fetchServerModels(config.serverUrl, config.apiKey);
  const availableModels = serverResult.models;
  deps.serverReasoningModels = serverResult.reasoningModels;
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

/** Effort levels the server backend supports (matches `effortToBudget` in query.ts). */
const SERVER_EFFORT_LEVELS = ["none", "low", "medium", "high"] as const;

const SERVER_EFFORT_DISPLAY: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const DEFAULT_SERVER_EFFORT = "high";

/** Check whether a string is a valid server-backend effort level. */
export const isValidServerEffort = (level: string) =>
  (SERVER_EFFORT_LEVELS as readonly string[]).includes(level);

/**
 * Build the backend-native `configOptions[]` for the given session.
 * Surfaces a thought-level selector for reasoning-capable server models.
 * Does NOT include the model selector — that's composed by the handler
 * from `buildModelConfigOption` since it depends on the merged models list.
 */
export const buildSessionConfigOptions = (
  deps: ModelResolutionDeps,
  session: SessionState,
) => {
  // Server backend — expose a thought-level selector for reasoning models.
  if (deps.serverReasoningModels.has(session.currentModelId)) {
    const currentLevel =
      session.currentThoughtLevel &&
      isValidServerEffort(session.currentThoughtLevel)
        ? session.currentThoughtLevel
        : DEFAULT_SERVER_EFFORT;

    const thoughtLevelOption: acp.SessionConfigOption = {
      type: "select",
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      currentValue: currentLevel,
      options: SERVER_EFFORT_LEVELS.map((level) => ({
        value: level,
        name: SERVER_EFFORT_DISPLAY[level] ?? level,
      })),
    };
    return [thoughtLevelOption];
  }

  return [];
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
