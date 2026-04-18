/**
 * Claude Code model discovery via the Agent SDK.
 *
 * Spawns a throwaway `query()` subprocess at agent startup to call
 * `supportedModels()` — the only way to get CC's model catalogue when
 * the user authenticates via OAuth (no ANTHROPIC_API_KEY in env).
 * The subprocess handles its own auth and knows which models are available.
 *
 * Returns ACP ModelInfo entries prefixed with `claude-code/`, falling
 * back to the static alias list when the SDK doesn't respond.
 */

import type { ModelInfo } from "@agentclientprotocol/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CCBackendConfig } from "../../config";
import { CC_PREFIX, getCCModelList } from "../../routing";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { setModelCapabilities } from "./model-capabilities";

const logger = createChildLogger(log, "cc-models");

const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Discover available Claude Code models by spawning a throwaway SDK query
 * and calling supportedModels() on the subprocess.
 *
 * Blocks until the model list arrives or the timeout fires. Falls back
 * to getCCModelList() when the subprocess doesn't respond.
 */
export const discoverCCModelsViaSdk = async (
  cc: CCBackendConfig,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<ModelInfo[]> => {
  async function* emptyPrompt() {
    // Intentionally yields nothing — we only need the subprocess alive
    // long enough for supportedModels().
  }

  // Wrap query() in a promise so sync throws (binary not found, spawn
  // failure) become a rejection we can handle without try/catch.
  const q = await Promise.resolve()
    .then(() =>
      query({
        prompt: emptyPrompt(),
        options: {
          cwd: process.cwd(),
          systemPrompt: "",
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          settingSources: [],
        },
      }),
    )
    .catch(errMessage);

  if (typeof q === "string") {
    logger.warn(`CC subprocess spawn failed: ${q}`);
    return [];
  }

  // Race supportedModels() against a timeout. The two-arg .then() clears
  // the timer on both paths to avoid dangling handles and unhandled
  // rejections from the losing branch.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const models = await Promise.race([
    q.supportedModels(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`supportedModels timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).then(
    (result) => {
      clearTimeout(timer);
      return result;
    },
    (err) => {
      clearTimeout(timer);
      return errMessage(err);
    },
  );

  q.close();

  if (typeof models === "string") {
    logger.warn(`CC model discovery failed: ${models}`);
    return getCCModelList(cc);
  }

  if (models.length === 0) return getCCModelList(cc);

  // Preserve capability flags (supportsAdaptiveThinking, etc.) in the
  // module-level cache before we transform to the narrower ACP ModelInfo
  // shape. buildSdkOptions reads this cache per-request to pick the right
  // thinking config.
  setModelCapabilities(models);

  logger.info(`discovered ${models.length} CC models from SDK subprocess`);
  return models.map((m) => ({
    modelId: `${CC_PREFIX}${m.value}`,
    name: m.displayName,
    description: m.description ?? "Routed through the Claude Code Agent SDK",
  }));
};
