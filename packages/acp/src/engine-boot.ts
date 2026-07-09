/**
 * Engine boot for the local backend (MIM-89).
 *
 * One-time process-level initialization of the plugin-core inference
 * engine: redirect engine logging into the ACP log, load models.dev
 * provider data, build the provider registry (providers register from
 * standard env vars — the user's BYOK keys in the editor's env block),
 * and start the TTL refresh chain.
 *
 * Also owns the system prompt: fetched from mimir-server once and cached
 * in memory for the ACP process lifetime (Rage's explicit call — the
 * route survives for cc-plugin install, but ACP reads it exactly once).
 * Fetch failure logs loud and runs the turn with an empty prompt while
 * leaving the cache unset so a later turn retries.
 */

import { setEngineLogger } from "@mimir/plugin-core/engine/log";
import {
  initProviderRegistry,
  loadProviderData,
  startProviderDataRefresh,
} from "@mimir/plugin-core/engine/provider";
import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import { errMessage } from "@mimir/plugin-core/util";
import type { MimirConfig } from "./config";
import { createChildLogger, log } from "./utils/log";

const logger = createChildLogger(log, "engine-boot");

let enginePromise: Promise<void> | null = null;

/**
 * Idempotent engine boot — the first caller starts it, everyone else
 * awaits the same promise. Kicked off eagerly at agent creation and
 * awaited on the turn path so the first prompt never races the registry.
 */
export const ensureEngineReady = () => {
  enginePromise ??= (async () => {
    setEngineLogger(createChildLogger(log, "engine"));
    await loadProviderData();
    initProviderRegistry();
    // Refresh re-runs registry init so newly published models register
    // without a restart — same wiring the server used.
    startProviderDataRefresh(() => initProviderRegistry());
    logger.info("provider engine initialized");
    // Silent key reconcile (MIM-87): fulfil pending wraps, surface owed
    // ceremonies in the log. Detached — the ACP process is long-lived,
    // engine readiness never waits on the network. Never mints secrets.
    void reconcileFromSharedConfig()
      .then((result) => logger.info(`key reconcile: ${JSON.stringify(result)}`))
      .catch((err) => logger.warn(`key reconcile failed: ${errMessage(err)}`));
  })();
  return enginePromise;
};

let systemPromptCache: string | null = null;

/**
 * System prompt with process-lifetime caching. Success caches forever;
 * failure returns "" WITHOUT caching so the next turn retries.
 */
export const getSystemPrompt = async (config: MimirConfig) => {
  if (systemPromptCache !== null) return systemPromptCache;

  const headers: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};
  const res = await fetch(`${config.serverUrl}/v1/system-prompt`, {
    headers,
  }).catch(errMessage);
  if (typeof res === "string") {
    logger.error(`system prompt fetch failed: ${res} — running without it`);
    return "";
  }
  if (!res.ok) {
    logger.error(
      `system prompt fetch failed: ${res.status} ${res.statusText} — running without it`,
    );
    return "";
  }
  const body = await res.json().catch(errMessage);
  if (typeof body === "string") {
    logger.error(`system prompt fetch — invalid JSON: ${body}`);
    return "";
  }
  // Route shape: { content, version } — see server routes/system-prompt.ts.
  const content = (body as { content?: string }).content;
  if (typeof content !== "string" || content.length === 0) {
    logger.error("system prompt fetch — response carried no content field");
    return "";
  }
  systemPromptCache = content;
  logger.info(`system prompt cached (${content.length} chars)`);
  return systemPromptCache;
};

/** Test seam — reset the module caches between cases. */
export const _resetEngineBootForTests = () => {
  enginePromise = null;
  systemPromptCache = null;
};
