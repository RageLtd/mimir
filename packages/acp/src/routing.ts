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
  // Wrap Bun.spawn in Promise.resolve so synchronous throws (binary not
  // found) become a rejection we can handle without try/catch.
  const code = await Promise.resolve()
    .then(
      () =>
        Bun.spawn(["claude", "--version"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
    )
    .catch((err) => {
      logger.debug("claude binary not found:", errMessage(err));
      return -1;
    });
  return code === 0;
};

// ── Server model list fetch + merge ──

type ServerModelEntry = {
  id: string;
  object?: string;
  owned_by?: string;
  /** Human-readable model name from provider-data (e.g. "Kimi K2.5"). */
  display_name?: string;
  /** Human-readable provider name from provider-data (e.g. "OpenCode Go"). */
  provider_name?: string;
};

/**
 * Titlecase fallback for `owned_by` when the server didn't include a
 * `provider_name`. Splits on dashes and underscores, capitalises each
 * part. Keeps unknown providers visually distinct from registered ones
 * without requiring a client-side provider catalogue.
 *
 * Exported for unit testing.
 */
export const titlecaseProviderId = (id: string) =>
  id
    .split(/[-_]/g)
    .map((part) =>
      part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : "",
    )
    .join(" ");

/**
 * Compose the `name` field shown in the editor's model selector.
 * `display_name (provider_name)` when both are present; falls back to
 * `display_name` (no parenthetical), or `id (provider)` when only the
 * provider is known, or just `id` for entries with no enrichment.
 *
 * Exported for unit testing.
 */
export const composeServerModelName = (m: ServerModelEntry) => {
  const display = m.display_name ?? m.id;
  if (!m.owned_by) return display;
  const provider = m.provider_name ?? titlecaseProviderId(m.owned_by);
  return `${display} (${provider})`;
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
  const url = `${serverUrl}/v1/models`;
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  const res = await fetch(url, { headers, signal }).catch(errMessage);
  if (typeof res === "string") {
    logger.warn(`server model fetch failed: ${res} (${url})`);
    return [];
  }
  if (!res.ok) {
    logger.warn(
      `server model fetch failed: ${res.status} ${res.statusText} (${url})`,
    );
    return [];
  }
  const body = await res.json().catch(errMessage);
  if (typeof body === "string") {
    logger.warn(`server model fetch — invalid JSON: ${body} (${url})`);
    return [];
  }
  const data = (body as { data?: ServerModelEntry[] }).data ?? [];
  const models = data.map((m) => ({
    modelId: m.id,
    name: composeServerModelName(m),
    description: m.owned_by ? `Provider: ${m.owned_by}` : undefined,
  }));
  logger.info(`fetched ${models.length} models from mimir-server`);
  return models;
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
const EMPTY_COPILOT_RESULT = {
  available: false,
  models: [] as ModelInfo[],
  modelMap: new Map<string, string>(),
};

export const discoverCopilotModels = async () => {
  const client = new CopilotClient();

  const startErr = await client.start().then(
    () => undefined,
    (err) => errMessage(err),
  );
  if (startErr !== undefined) {
    logger.debug("Copilot CLI not available:", startErr);
    return EMPTY_COPILOT_RESULT;
  }

  const listed = await client.listModels().then(
    (models) => ({ ok: true as const, models }),
    (err) => ({ ok: false as const, error: errMessage(err) }),
  );
  // Best-effort cleanup; client.stop() may itself reject if start half-completed.
  await client
    .stop()
    .catch((err) =>
      logger.debug("Copilot client.stop failed:", errMessage(err)),
    );

  if (!listed.ok) {
    logger.debug("Copilot listModels failed:", listed.error);
    return EMPTY_COPILOT_RESULT;
  }

  const modelMap = new Map<string, string>();
  const modelList: ModelInfo[] = listed.models.map((m) => {
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
};

// ── Model merging ──

/** Merge server + CC + Copilot models. CC and Copilot entries come first. */
export const mergeModels = (
  serverModels: ModelInfo[],
  ccModels: ModelInfo[],
  copilotModels: ModelInfo[] = [],
) => [...ccModels, ...copilotModels, ...serverModels];
