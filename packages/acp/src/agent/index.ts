/**
 * ACP Agent factory — the module manifest.
 *
 * Creates the ACP Agent implementation that Zed (or any ACP client)
 * connects to over stdio. This file is a thin wiring layer: it constructs
 * the shared dependency record and maps each `acp.Agent` method to its
 * handler in `./handlers.ts`. Implementation logic lives next to the handler
 * or helper that owns it.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { createUserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { createBackendRouter } from "../backends";
import {
  type CartographerManager,
  createCartographerManager,
} from "../cartographer/lifecycle";
import { config } from "../config";
import { createSessionStore } from "../store/sessions";
import { createAgentCore } from "./core";
import type { HandlerDeps } from "./handlers";
import * as handlers from "./handlers";

export const createMimirAgent = (conn: acp.AgentSideConnection): acp.Agent => {
  const memoryStore = createUserMemoryStore(config.userMemoryDbPath);
  const sessionStore = createSessionStore(config.sessionDbPath);
  const router = createBackendRouter(config);

  const cartographer: CartographerManager | null = config.cartographer.enabled
    ? createCartographerManager({
        binaryPath: config.cartographer.binaryPath,
        env: config.cartographer.env,
      })
    : null;

  const core = createAgentCore(
    config,
    memoryStore,
    router,
    sessionStore,
    cartographer,
  );

  // Mutable state held in the factory closure and exposed to handlers via
  // getter/setter pairs. One connection = one Zed window, so this state is
  // per-connection; handlers never see cross-connection leakage.
  let clientCapabilities: acp.ClientCapabilities = {};

  const deps: HandlerDeps = {
    core,
    conn,
    config,
    router,
    memoryStore,
    cartographer,
    getClientCapabilities: () => clientCapabilities,
    setClientCapabilities: (caps) => {
      clientCapabilities = caps;
    },
    commandsEmitted: new Set<string>(),
    serverReasoningModels: new Set<string>(),
  };

  return {
    initialize: (params) => handlers.initialize(deps, params),
    newSession: (params) => handlers.newSession(deps, params),
    loadSession: (params) => handlers.loadSession(deps, params),
    listSessions: (params) => handlers.listSessions(deps, params),
    authenticate: (params) => handlers.authenticate(deps, params),
    prompt: (params) => handlers.prompt(deps, params),
    cancel: (params) => handlers.cancel(deps, params),
    setSessionMode: (params) => handlers.setSessionMode(deps, params),
    setSessionConfigOption: (params) =>
      handlers.setSessionConfigOption(deps, params),
    unstable_setSessionModel: (params) =>
      handlers.setSessionModel(deps, params),
  };
};
