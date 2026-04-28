/**
 * Backend factory.
 *
 * Backend selection is driven by the model id (per-request), not by a
 * static config. `claude-code/*` routes through the Claude Code Agent SDK;
 * every other model routes through mimir-server.
 *
 * The two backends are constructed once and selected by model on each
 * call so users can switch models mid-conversation.
 */

import type { MimirConfig } from "../config";
import { isCCModel, isCopilotModel } from "../routing";
import type { ServerClientConfig } from "../server-client";
import { createClaudeCodeBackend } from "./claude-code";
import { createCopilotBackend } from "./copilot/adapter";
import { createServerBackend } from "./server";
import type { Backend } from "./types";

/**
 * Mutable runtime state shared with the agent. Set after startup
 * auto-detection of CLI backends, then read on every routing decision
 * so we never spawn a backend whose CLI isn't actually installed.
 */
export type RuntimeState = {
  ccEnabled: boolean;
  copilotEnabled: boolean;
  /** Discovered Copilot model IDs, keyed by suffix for routing. */
  copilotModelMap: Map<string, string>;
};

/**
 * Result shape from `forModel`. `ok: true` carries the backend; `ok: false`
 * carries the human-readable reason (typically: the matching backend is
 * disabled). Callers surface `error` to the user on failure rather than
 * catching a thrown exception — see error-handling rule.
 */
export type RouteResult =
  | { readonly ok: true; readonly backend: Backend }
  | { readonly ok: false; readonly error: string };

export type BackendRouter = {
  /** Return the backend that should serve the given model id. */
  readonly forModel: (modelId: string) => RouteResult;
  readonly server: Backend;
  readonly cc: Backend;
  readonly copilot: Backend;
  readonly runtime: RuntimeState;
};

export const createBackendRouter = (config: MimirConfig) => {
  const serverConfig: ServerClientConfig = {
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
  };
  const server = createServerBackend(serverConfig);
  const cc = createClaudeCodeBackend({
    cc: config.cc,
    serverUrl: config.serverUrl,
    userMemoryDbPath: config.userMemoryDbPath,
    defaultCwd: process.cwd(),
  });
  const copilot = createCopilotBackend({
    copilot: config.copilot,
    serverUrl: config.serverUrl,
    userMemoryDbPath: config.userMemoryDbPath,
    defaultCwd: process.cwd(),
  });
  const runtime: RuntimeState = {
    ccEnabled: config.cc.enabled,
    copilotEnabled: config.copilot.enabled,
    copilotModelMap: new Map(),
  };

  const forModel = (modelId: string) => {
    if (isCCModel(modelId)) {
      if (!runtime.ccEnabled) {
        return {
          ok: false as const,
          error: `Model ${modelId} requires the Claude Code backend, which is disabled.`,
        };
      }
      return { ok: true as const, backend: cc };
    }
    if (isCopilotModel(modelId)) {
      if (!runtime.copilotEnabled) {
        return {
          ok: false as const,
          error: `Model ${modelId} requires the Copilot backend, which is disabled.`,
        };
      }
      return { ok: true as const, backend: copilot };
    }
    return { ok: true as const, backend: server };
  };

  return { forModel, server, cc, copilot, runtime };
};

export type { Backend, BackendEvent, BackendRunOptions } from "./types";
