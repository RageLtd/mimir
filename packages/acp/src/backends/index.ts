/**
 * Backend factory.
 *
 * Backend selection is driven by the model id (per-request), not by a
 * static config. `claude-code/*` routes through the CC subprocess; every
 * other model routes through mimir-server.
 *
 * The two backends are constructed once and selected by model on each
 * call so users can switch models mid-conversation.
 */

import type { MimirConfig } from "../config";
import { isCCModel } from "../routing";
import type { ServerClientConfig } from "../server-client";
import { createClaudeCodeBackend } from "./claude-code";
import { createServerBackend } from "./server";
import type { Backend } from "./types";

/**
 * Mutable runtime state shared with the agent. Set after startup
 * auto-detection of the `claude` binary, then read on every routing
 * decision so we never spawn CC when it isn't actually installed.
 */
export type RuntimeState = {
  ccEnabled: boolean;
};

export type BackendRouter = {
  /** Return the backend that should serve the given model id. */
  readonly forModel: (modelId: string) => Backend;
  readonly server: Backend;
  readonly cc: Backend;
  readonly runtime: RuntimeState;
};

export const createBackendRouter = (config: MimirConfig): BackendRouter => {
  const serverConfig: ServerClientConfig = {
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
  };
  const server = createServerBackend(serverConfig);
  const cc = createClaudeCodeBackend({
    cc: config.cc,
    defaultCwd: process.cwd(),
  });
  const runtime: RuntimeState = { ccEnabled: config.cc.enabled };

  const forModel = (modelId: string): Backend => {
    if (isCCModel(modelId)) {
      if (!runtime.ccEnabled) {
        throw new Error(
          `Model ${modelId} requires the Claude Code backend, which is disabled.`,
        );
      }
      return cc;
    }
    return server;
  };

  return { forModel, server, cc, runtime };
};

export type { Backend, BackendEvent, BackendRunOptions } from "./types";
