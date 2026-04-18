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
import { CC_PREFIX, fetchServerModels, mergeModels } from "../routing";
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
 * Assemble the merged model list and pick an auto-selected default. When the
 * configured `MIMIR_MODEL` isn't in the merged list (common when it's unset
 * and defaults to "openrouter/auto", or when the format doesn't match the
 * discovered ids), fall back to the first available entry so Zed's picker
 * highlights something real.
 */
export const buildModelsState = async (deps: ModelResolutionDeps) => {
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
  const configured = availableModels.find((m) => m.modelId === config.model);
  if (!configured && availableModels.length > 0) {
    logger.info(
      `configured model "${config.model}" not in discovered list; ` +
        `falling back to "${availableModels[0]?.modelId}"`,
    );
  }
  const currentModelId =
    configured?.modelId ?? availableModels[0]?.modelId ?? config.model;
  const result = { availableModels, currentModelId };
  logger.info(
    "buildModelsState:",
    availableModels.length,
    "models, currentModelId:",
    currentModelId,
  );
  return result;
};

/**
 * Build a `"model"` category selector from the merged models list. Zed's
 * newer UI surfaces model selection through `configOptions` rather than the
 * legacy top-level `models` field — when any `configOptions` are present,
 * the model picker needs an entry here to render.
 */
export const buildModelConfigOption = (models: acp.SessionModelState) => {
  logger.info(
    "buildModelConfigOption input:",
    "currentModelId=",
    models.currentModelId,
    "availableModels=",
    models.availableModels.length,
  );
  const result = {
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
  };
  logger.info(
    "buildModelConfigOption output:",
    "options=",
    result.options.length,
    "currentValue=",
    result.currentValue,
  );
  return result;
};

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
  let backendKind: "claude-code" | "server" | "copilot";
  try {
    backendKind = deps.router.forModel(session.currentModelId).kind;
  } catch {
    return [];
  }
  if (backendKind !== "claude-code") return [];
  return buildCCConfigOptions({
    modelAlias: ccAliasFor(session.currentModelId),
    currentMode: session.currentMode || DEFAULT_CC_MODE,
    currentThoughtLevel: session.currentThoughtLevel,
    bypassPermissionsAllowed:
      deps.config.cc.permissionMode === "bypassPermissions",
  });
};
