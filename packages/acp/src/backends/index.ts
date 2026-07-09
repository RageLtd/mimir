/**
 * Backend factory.
 *
 * Every model runs on the local backend (MIM-89 inversion). The router
 * keeps its `forModel` lookup so the call sites stay backend-agnostic —
 * additional backends can be slotted in here later without touching the
 * agent loop.
 */

import { createLocalBackend } from "./local";
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
  readonly local: Backend;
};

export const createBackendRouter = () => {
  const local = createLocalBackend();

  return {
    forModel: (_modelId: string) => ({ ok: true as const, backend: local }),
    local,
  };
};

export type { Backend, BackendEvent, BackendRunOptions } from "./types";
