/**
 * Model-based backend routing.
 *
 * Models prefixed with `claude-code/` route through the CC subprocess
 * backend. Everything else routes through mimir-server.
 *
 * Backend selection is per-request, not per-session — the editor's
 * model dropdown determines the backend on every prompt.
 */

import type { ModelInfo } from "@agentclientprotocol/sdk";
import type { CCBackendConfig } from "./config";
import { createChildLogger, log } from "./utils/log";

const logger = createChildLogger(log, "routing");

export const CC_PREFIX = "claude-code/";

export const isCCModel = (modelId: string): boolean =>
  modelId.startsWith(CC_PREFIX);

/**
 * Map a `claude-code/<suffix>` model id to CC's --model flag value.
 * Falls back to the suffix as-is so unknown ids still pass through.
 */
export const getCCModelFlag = (
  modelId: string,
  cc: CCBackendConfig,
): string => {
  const suffix = modelId.slice(CC_PREFIX.length);
  return cc.models[suffix] ?? suffix;
};

/** Synthetic ModelInfo entries for the CC models the user has mapped. */
export const getCCModelList = (cc: CCBackendConfig): ModelInfo[] => {
  if (!cc.enabled) return [];
  return Object.keys(cc.models).map((suffix) => ({
    modelId: `${CC_PREFIX}${suffix}`,
    name: `Claude Code (${suffix})`,
    description: `Routed through the local Claude Code subprocess (--model ${cc.models[suffix]})`,
  }));
};

/** Detect whether the `claude` binary is on PATH. */
export const ccAvailable = async (): Promise<boolean> => {
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
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
): Promise<ModelInfo[]> => {
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
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`server model fetch failed: ${msg} (${serverUrl}/v1/models)`);
    return [];
  }
};

/** Merge server + CC models, with CC entries first. */
export const mergeModels = (
  serverModels: ModelInfo[],
  ccModels: ModelInfo[],
): ModelInfo[] => [...ccModels, ...serverModels];
