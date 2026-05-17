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
import { createBackendRouter } from "../backends";
import {
  defaultSystemPromptPath,
  loadVoiceAnchors,
} from "../backends/claude-code/voice-anchors";
import {
  type CartographerManager,
  createCartographerManager,
} from "../cartographer/lifecycle";
import { config } from "../config";
import type { ContextClientConfig } from "../context-client";
import { createSessionStore } from "../store/sessions";
import { createUserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { createAgentCore } from "./core";
import type { HandlerDeps } from "./handlers";
import * as handlers from "./handlers";

const logger = createChildLogger(log, "agent");

// Load the voice anchor library once at process startup. Parsing failures
// throw at module init — a malformed Voice in Action section surfaces at
// boot, not later. An empty library effectively disables anchor injection;
// nextAnchor() no-ops gracefully.
const anchorPath = config.cc.systemPromptPath ?? defaultSystemPromptPath();
const voiceAnchorLibrary = await loadVoiceAnchors(anchorPath);
logger.info(
  `Loaded ${voiceAnchorLibrary.length} voice anchors from ${anchorPath}`,
);

export const createMimirAgent = (conn: acp.AgentSideConnection): acp.Agent => {
  const memoryStore = createUserMemoryStore(config.userMemoryDbPath);
  const sessionStore = createSessionStore(config.sessionDbPath);
  const router = createBackendRouter(config);
  const contextClient: ContextClientConfig = {
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    systemPromptTtlMs: config.systemPromptTtlMs,
  };

  const cartographer: CartographerManager | null = config.cartographer.enabled
    ? createCartographerManager({
        binaryPath: config.cartographer.binaryPath,
        env: config.cartographer.env,
        serverUrl: config.serverUrl,
        apiKey: config.apiKey,
      })
    : null;

  const core = createAgentCore(
    config,
    memoryStore,
    router,
    contextClient,
    sessionStore,
    { voiceAnchorLibrary, anchorInterval: config.cc.anchorInterval },
    cartographer,
  );

  // Mutable state held in the factory closure and exposed to handlers via
  // getter/setter pairs. One connection = one Zed window, so this state is
  // per-connection; handlers never see cross-connection leakage.
  let discoveredCCModels: readonly acp.ModelInfo[] = [];
  let discoveredCodexModels: readonly acp.ModelInfo[] = [];
  let discoveredCopilotModels: readonly acp.ModelInfo[] = [];
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
    getDiscoveredCCModels: () => discoveredCCModels,
    setDiscoveredCCModels: (ms) => {
      discoveredCCModels = ms;
    },
    getDiscoveredCodexModels: () => discoveredCodexModels,
    setDiscoveredCodexModels: (ms) => {
      discoveredCodexModels = ms;
    },
    getDiscoveredCopilotModels: () => discoveredCopilotModels,
    setDiscoveredCopilotModels: (ms) => {
      discoveredCopilotModels = ms;
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
