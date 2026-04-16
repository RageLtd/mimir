/**
 * Model-based backend routing.
 *
 * Models prefixed with `claude-code/` route through the Claude Code
 * Agent SDK backend. Models prefixed with `copilot/` route through the
 * GitHub Copilot SDK backend, with models discovered at startup via
 * CopilotClient.listModels(). Everything else routes through mimir-server.
 *
 * Backend selection is per-request, not per-session — the editor's
 * model dropdown determines the backend on every prompt.
 */

import type { ModelInfo } from "@agentclientprotocol/sdk";
import { CopilotClient } from "@github/copilot-sdk";
import type { CCBackendConfig } from "./config";

// Re-export so callers don't need to reach into backends/.
export { discoverCCModelsViaSdk } from "./backends/claude-code/models";

import { errMessage } from "./util";
import { createChildLogger, log } from "./utils/log";

const logger = createChildLogger(log, "routing");

// ── Claude Code routing ──

export const CC_PREFIX = "claude-code/";

export const isCCModel = (modelId: string) => modelId.startsWith(CC_PREFIX);

/**
 * Map a `claude-code/<suffix>` model id to CC's --model flag value.
 * Falls back to the suffix as-is so unknown ids still pass through.
 */
export const getCCModelFlag = (modelId: string, cc: CCBackendConfig) => {
  const suffix = modelId.slice(CC_PREFIX.length);
  return cc.models[suffix] ?? suffix;
};

/** Synthetic ModelInfo entries for the CC models the user has mapped. */
export const getCCModelList = (cc: CCBackendConfig) => {
  if (!cc.enabled) return [];
  return Object.keys(cc.models).map((suffix) => ({
    modelId: `${CC_PREFIX}${suffix}`,
    name: `Claude Code (${suffix})`,
    description: `Routed through the Claude Code Agent SDK (model: ${cc.models[suffix]})`,
  }));
};

/** Detect whether the `claude` binary is on PATH. */
export const ccAvailable = async () => {
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch (err) {
    logger.debug(
      "claude binary not found:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
};

// ── Server model list fetch + merge ──

type ServerModelEntry = {
  id: string;
  object?: string;
  owned_by?: string;
};

/**
 * Fetch mimir-server's `/v1/models` and return entries as ACP ModelInfo.
 * Returns an empty list on failure so CC models are still available.
 */
export const fetchServerModels = async (
  serverUrl: string,
  apiKey: string,
  signal?: AbortSignal,
) => {
  try {
    const headers: Record<string, string> = apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};
    const res = await fetch(`${serverUrl}/v1/models`, { headers, signal });
    if (!res.ok) {
      logger.warn(
        `server model fetch failed: ${res.status} ${res.statusText} (${serverUrl}/v1/models)`,
      );
      return [];
    }
    const body = (await res.json()) as { data?: ServerModelEntry[] };
    const models = (body.data ?? []).map((m) => ({
      modelId: m.id,
      name: m.id,
      description: m.owned_by ? `Provider: ${m.owned_by}` : undefined,
    }));
    logger.info(`fetched ${models.length} models from mimir-server`);
    return models;
  } catch (err) {
    const msg = errMessage(err);
    logger.warn(`server model fetch failed: ${msg} (${serverUrl}/v1/models)`);
    return [];
  }
};

// ── Copilot routing ──

export const COPILOT_PREFIX = "copilot/";

export const isCopilotModel = (modelId: string) =>
  modelId.startsWith(COPILOT_PREFIX);

/**
 * Map a `copilot/<suffix>` model id to the Copilot SDK model value.
 * Uses the discovered model list if available, falling back to the suffix as-is.
 */
export const getCopilotModelFlag = (
  modelId: string,
  discoveredModels: Map<string, string>,
) => {
  const suffix = modelId.slice(COPILOT_PREFIX.length);
  return discoveredModels.get(suffix) ?? suffix;
};

/**
 * Detect whether the Copilot CLI is available and discover models.
 *
 * Spawns a CopilotClient, calls listModels(), then stops the client.
 * Returns the discovered models as ACP ModelInfo entries prefixed with
 * `copilot/`, plus a map from suffix → SDK model id for routing.
 * Returns empty results on failure so other backends are still available.
 */
export const discoverCopilotModels = async () => {
  const client = new CopilotClient();
  try {
    await client.start();
    const models = await client.listModels();
    await client.stop();

    const modelMap = new Map<string, string>();
    const modelList: ModelInfo[] = models.map((m) => {
      modelMap.set(m.id, m.id);
      return {
        modelId: `${COPILOT_PREFIX}${m.id}`,
        name: `Copilot (${m.name ?? m.id})`,
        description: m.capabilities?.limits?.max_context_window_tokens
          ? `Context: ${m.capabilities.limits.max_context_window_tokens} tokens`
          : undefined,
      };
    });

    logger.info(`discovered ${modelList.length} Copilot models`);
    return { available: true, models: modelList, modelMap };
  } catch (err) {
    logger.debug("Copilot CLI not available:", errMessage(err));
    try {
      await client.stop();
    } catch {
      // Client may not have started successfully.
    }
    return {
      available: false,
      models: [] as ModelInfo[],
      modelMap: new Map<string, string>(),
    };
  }
};

// ── Model merging ──

/** Merge server + CC + Copilot models. CC and Copilot entries come first. */
export const mergeModels = (
  serverModels: ModelInfo[],
  ccModels: ModelInfo[],
  copilotModels: ModelInfo[] = [],
) => [...ccModels, ...copilotModels, ...serverModels];
