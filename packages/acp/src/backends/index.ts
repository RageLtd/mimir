/**
 * Backend factory.
 *
 * Every model routes through mimir-server. The router exposes a
 * `forModel` lookup so the call sites stay backend-agnostic — additional
 * backends can be slotted in here later without touching the agent loop.
 */

import type { MimirConfig } from "../config";
import type { ServerClientConfig } from "../server-client";
import { createServerBackend } from "./server";
import type { Backend } from "./types";

/**
 * Result shape from `forModel`. `ok: true` carries the backend; `ok: false`
 * carries the human-readable reason. Callers surface `error` to the user on
 * failure rather than catching a thrown exception — see error-handling rule.
 */
export type RouteResult =
  | { readonly ok: true; readonly backend: Backend }
  | { readonly ok: false; readonly error: string };

export type BackendRouter = {
  /** Return the backend that should serve the given model id. */
  readonly forModel: (modelId: string) => RouteResult;
  readonly server: Backend;
};

export const createBackendRouter = (config: MimirConfig) => {
  const serverConfig: ServerClientConfig = {
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
  };
  const server = createServerBackend(serverConfig);

  return {
    forModel: (_modelId: string) => ({ ok: true as const, backend: server }),
    server,
  };
};

export type { Backend, BackendEvent, BackendRunOptions } from "./types";
