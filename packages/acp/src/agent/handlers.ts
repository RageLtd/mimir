/**
 * ACP method handlers.
 *
 * Each exported function implements one of the methods on the `acp.Agent`
 * interface. They close over a `HandlerDeps` record rather than the factory
 * closure so they're individually testable and the factory in `index.ts`
 * stays a thin manifest.
 */

import * as acp from "@agentclientprotocol/sdk";
import type { BackendRouter } from "../backends";
import {
  isValidCCMode,
  isValidThoughtLevel,
} from "../backends/claude-code/config-options";
import { discoverCCModelsViaSdk } from "../backends/claude-code/models";
import { checkForSdkUpdate } from "../backends/claude-code/sdk-updater";
import type { CartographerManager } from "../cartographer/lifecycle";
import type { MimirConfig } from "../config";
import { assembleClientMcpServers } from "../mcp-config/assemble";
import { ccAvailable, discoverCopilotModels } from "../routing";
import type { UserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { handleCommand } from "./commands";
import { formatContentBlocks } from "./content";
import {
  advertisedContextSize,
  emitUsageUpdate,
  maybeEmitCommandsList,
  maybeSetSessionTitle,
  replayHistoryToEditor,
  surfaceRuleLoadErrors,
} from "./lifecycle-helpers";
import {
  buildSessionConfigOptions,
  ccAliasFor,
  composeSessionResponse,
  type ModelResolutionDeps,
} from "./model-resolution";
import { parseCommand } from "./session";
import type { AgentCore } from "./types";

const logger = createChildLogger(log, "handlers");

export type HandlerDeps = ModelResolutionDeps & {
  readonly core: AgentCore;
  readonly conn: acp.AgentSideConnection;
  readonly config: MimirConfig;
  readonly router: BackendRouter;
  readonly memoryStore: UserMemoryStore;
  readonly cartographer: CartographerManager | null;
  readonly getClientCapabilities: () => acp.ClientCapabilities;
  readonly setClientCapabilities: (caps: acp.ClientCapabilities) => void;
  readonly setDiscoveredCCModels: (ms: readonly acp.ModelInfo[]) => void;
  readonly setDiscoveredCopilotModels: (ms: readonly acp.ModelInfo[]) => void;
  /** Tracks which sessions have already received available_commands_update,
   *  so we emit it once per session on the first prompt call rather than
   *  during session creation (which races with the client registration). */
  commandsEmitted: Set<string>;
};

// ── initialize ──────────────────────────────────────────────────────────────

export const initialize = async (
  deps: HandlerDeps,
  params: acp.InitializeRequest,
) => {
  const { config, router } = deps;
  deps.setClientCapabilities(params.clientCapabilities ?? {});
  logger.info("client capabilities:", params.clientCapabilities);

  if (config.cc.enabled) {
    checkForSdkUpdate().catch((err) =>
      logger.warn("SDK update check failed:", err),
    );
  }

  const [ccResult, ccModelsResult, copilotResult] = await Promise.all([
    config.cc.enabled
      ? ccAvailable().then((available) => ({ available }))
      : Promise.resolve({ available: false }),
    config.cc.enabled
      ? discoverCCModelsViaSdk(config.cc)
      : Promise.resolve([] as acp.ModelInfo[]),
    config.copilot.enabled
      ? discoverCopilotModels()
      : Promise.resolve({
          available: false,
          models: [] as acp.ModelInfo[],
          modelMap: new Map<string, string>(),
        }),
  ]);

  router.runtime.ccEnabled = ccResult.available;
  deps.setDiscoveredCCModels(ccModelsResult);
  logger.info(
    ccResult.available
      ? `CC backend enabled (${ccModelsResult.length} models discovered)`
      : config.cc.enabled
        ? "claude binary not found on PATH; disabling CC backend"
        : "CC backend disabled by config",
  );

  router.runtime.copilotEnabled = copilotResult.available;
  router.runtime.copilotModelMap = copilotResult.modelMap;
  deps.setDiscoveredCopilotModels(copilotResult.models);
  logger.info(
    copilotResult.available
      ? `Copilot backend enabled (${copilotResult.models.length} models discovered)`
      : config.copilot.enabled
        ? "Copilot CLI not available; disabling Copilot backend"
        : "Copilot backend disabled by config",
  );

  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {} },
    },
  };
};

// ── session lifecycle ───────────────────────────────────────────────────────

export const newSession = async (
  deps: HandlerDeps,
  params: acp.NewSessionRequest,
) => {
  const projectPath = params.cwd || process.cwd();
  // Compose `.mcp.json` (project + global) with the client-supplied list and
  // attach Bearer headers from any prior OAuth flows. Snapshot the original
  // client-supplied list on the session so `/mcp reload` can re-merge against
  // it later without losing UI-configured Zed entries.
  const authedServers = await assembleClientMcpServers(
    projectPath,
    params.mcpServers,
  );
  const session = deps.core.newSession(
    projectPath,
    authedServers,
    deps.getClientCapabilities(),
    (errors) => surfaceRuleLoadErrors(deps.conn, session.sessionId, errors),
  );
  session.clientSuppliedMcpServers = params.mcpServers;
  logger.info("new session:", session.sessionId, "cwd:", projectPath);

  // getProjectId is read at sync time — the resolver runs in parallel with
  // session init, so the UUID may be unavailable now but populated by the
  // time cartographer actually posts the index.
  deps.cartographer?.autoIndex(projectPath, () => session.projectId);

  // Pass the freshly-created session's currentModelId as preferred so that
  // when MIMIR_MODEL is unset and we fall back to the first discovered
  // model, the configOptions response and the session state agree on what's
  // selected. Sync session state to whatever buildModelsState resolved.
  const { models, configOptions } = await composeSessionResponse(
    deps,
    session,
    session.currentModelId,
  );
  if (models?.currentModelId) {
    deps.core.setModel(session.sessionId, models.currentModelId);
  }
  logger.info("newSession configOptions:", configOptions.length, "entries");

  // Emit available_commands_update + initial usage_update after all async
  // work completes so the notifications are sent on the next macrotask —
  // after the SDK has flushed the session/new response as a microtask.
  // Placing these before the first await races the client, which hasn't
  // registered the session yet and discards the notification as "failed to
  // get session". The initial usage_update advertises capacity to Zed so
  // the progress bar appears immediately rather than waiting for the first
  // prompt's finish event.
  setTimeout(() => {
    maybeEmitCommandsList(deps.conn, deps.commandsEmitted, session.sessionId);
    const size = advertisedContextSize(session.currentModelId);
    if (size > 0) {
      emitUsageUpdate(deps.conn, session.sessionId, 0, size);
    }
  }, 0);

  return {
    sessionId: session.sessionId,
    ...(models ? { models } : {}),
    ...(configOptions.length > 0 ? { configOptions } : {}),
  };
};

export const loadSession = async (
  deps: HandlerDeps,
  params: acp.LoadSessionRequest,
) => {
  // First-pass restore so we have an authoritative `projectPath` for the
  // `.mcp.json` lookup — works for both warm (already in-memory) and cold
  // (restored from sessionStore) paths.
  const initialSession = deps.core.restoreSession(
    params.sessionId,
    params.mcpServers,
    deps.getClientCapabilities(),
  );
  if (!initialSession) {
    logger.warn("loadSession: unknown session", params.sessionId);
    return {};
  }
  // Re-assemble the effective server list so edits to `.mcp.json` (or its
  // global counterpart) and freshly-completed OAuth flows take effect on
  // resume. The second restoreSession call is hot-path-only (in-memory) and
  // idempotent when servers are unchanged.
  const authedServers = await assembleClientMcpServers(
    initialSession.projectPath,
    params.mcpServers,
  );
  const session = deps.core.restoreSession(
    params.sessionId,
    authedServers,
    deps.getClientCapabilities(),
    (errors) => surfaceRuleLoadErrors(deps.conn, params.sessionId, errors),
  );
  if (!session) {
    logger.warn("loadSession: unknown session", params.sessionId);
    return {};
  }
  session.clientSuppliedMcpServers = params.mcpServers;
  logger.info(
    "loadSession:",
    params.sessionId,
    `(${session.messages.length} messages)`,
  );

  // Pass the persisted session's currentModelId so the picker reflects the
  // user's prior selection rather than reverting to the env-var default.
  const { models, configOptions } = await composeSessionResponse(
    deps,
    session,
    session.currentModelId,
  );
  maybeEmitCommandsList(deps.conn, deps.commandsEmitted, params.sessionId);

  deps.conn
    .sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: session.currentMode,
      },
    })
    .catch((err) =>
      logger.warn("loadSession: current_mode_update failed:", err),
    );

  replayHistoryToEditor(deps.conn, params.sessionId, session.messages);

  if (session.title) {
    deps.conn
      .sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: session.title,
          updatedAt: new Date().toISOString(),
        },
      })
      .catch((err) =>
        logger.debug("loadSession: session_info_update failed:", err),
      );
  }

  // Initial usage_update so Zed's progress bar appears immediately on resume
  // — `used: 0` is honest because the SDK session was discarded across
  // processes and the next prompt rebuilds context from server-assembled
  // state. The first turn's finish event then updates `used` to the real
  // value the SDK reports.
  const size = advertisedContextSize(session.currentModelId);
  if (size > 0) {
    emitUsageUpdate(deps.conn, params.sessionId, 0, size);
  }

  logger.info("loadSession configOptions:", configOptions.length, "entries");
  return {
    ...(models ? { models } : {}),
    ...(configOptions.length > 0 ? { configOptions } : {}),
  };
};

export const listSessions = async (
  deps: HandlerDeps,
  _params: acp.ListSessionsRequest,
) => {
  const persisted = deps.core.listSessions();
  return {
    sessions: persisted.map((s) => ({
      sessionId: s.session_id,
      cwd: s.project_path,
      title: s.title ?? undefined,
      updatedAt: s.updated_at,
    })),
  };
};

// ── model / mode / config option handlers ───────────────────────────────────

export const setSessionModel = async (
  deps: HandlerDeps,
  params: acp.SetSessionModelRequest,
) => {
  const ok = deps.core.setModel(params.sessionId, params.modelId);
  if (!ok) {
    logger.warn("setSessionModel: unknown session", params.sessionId);
    return {};
  }
  logger.info("model set:", params.sessionId, "→", params.modelId);

  // Thought-level catalogue depends on the model — re-resolve and drop any
  // stale selection that the new model doesn't support.
  const session = deps.core.getSession(params.sessionId);
  if (!session) return {};
  const configOptions = buildSessionConfigOptions(deps, session);
  const thoughtOption = configOptions.find((o) => o.id === "thought_level");
  if (
    thoughtOption?.type === "select" &&
    session.currentThoughtLevel &&
    !(thoughtOption.options as { value: string }[]).some(
      (o) => o.value === session.currentThoughtLevel,
    )
  ) {
    deps.core.setThoughtLevel(
      params.sessionId,
      thoughtOption.currentValue as string,
    );
  }
  // Re-advertise capacity for the newly-selected model so the progress bar
  // appears or disappears as the user toggles between CC and non-CC models.
  const size = advertisedContextSize(params.modelId);
  if (size > 0) {
    emitUsageUpdate(deps.conn, params.sessionId, 0, size);
  }
  return {};
};

export const setSessionMode = async (
  deps: HandlerDeps,
  params: acp.SetSessionModeRequest,
) => {
  const ok = deps.core.setMode(params.sessionId, params.modeId);
  if (!ok) {
    logger.warn(
      "setSessionMode: unknown session or invalid mode",
      params.sessionId,
      params.modeId,
    );
    return {};
  }
  logger.info("mode set:", params.sessionId, "→", params.modeId);
  await deps.conn.sessionUpdate({
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: params.modeId,
    },
  });
  return {};
};

const applyModeChange = async (
  deps: HandlerDeps,
  sessionId: string,
  value: string,
) => {
  if (!isValidCCMode(value)) {
    logger.warn("setSessionConfigOption: invalid mode", value);
    return;
  }
  deps.core.setMode(sessionId, value);
  await deps.conn
    .sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: value,
      },
    })
    .catch((err) =>
      logger.debug("applyModeChange: current_mode_update failed:", err),
    );
  logger.info("mode set:", sessionId, "→", value);
};

const applyThoughtLevelChange = (
  deps: HandlerDeps,
  sessionId: string,
  modelAlias: string | undefined,
  value: string,
) => {
  if (!isValidThoughtLevel(value, modelAlias)) {
    logger.warn("setSessionConfigOption: invalid thought_level", value);
    return;
  }
  deps.core.setThoughtLevel(sessionId, value);
  logger.info("thought_level set:", sessionId, "→", value);
};

export const setSessionConfigOption = async (
  deps: HandlerDeps,
  params: acp.SetSessionConfigOptionRequest,
) => {
  const session = deps.core.getSession(params.sessionId);
  if (!session) {
    logger.warn("setSessionConfigOption: unknown session", params.sessionId);
    return { configOptions: [] };
  }
  if (typeof params.value === "boolean") {
    logger.warn(
      "setSessionConfigOption: unexpected boolean value for",
      params.configId,
    );
    return { configOptions: buildSessionConfigOptions(deps, session) };
  }

  if (params.configId === "mode") {
    await applyModeChange(deps, params.sessionId, params.value);
  } else if (params.configId === "thought_level") {
    const alias = ccAliasFor(session.currentModelId);
    applyThoughtLevelChange(deps, params.sessionId, alias, params.value);
  } else if (params.configId === "model") {
    // Model switch via configOptions path — delegate to the same logic as
    // unstable_setSessionModel so thought-level narrowing happens.
    await setSessionModel(deps, {
      sessionId: params.sessionId,
      modelId: params.value,
    });
  } else {
    logger.warn("setSessionConfigOption: unknown configId", params.configId);
  }

  // Pass the just-updated session.currentModelId so the model selector's
  // currentValue reflects the user's choice. Without this, picking a model
  // appears to revert in Zed because the response advertises the env-var
  // default instead.
  const { configOptions } = await composeSessionResponse(
    deps,
    session,
    session.currentModelId,
  );
  logger.info(
    "setSessionConfigOption configOptions:",
    configOptions.length,
    "entries",
  );
  return { configOptions };
};

// ── prompt ──────────────────────────────────────────────────────────────────

export const prompt = async (deps: HandlerDeps, params: acp.PromptRequest) => {
  const promptText = formatContentBlocks(params.prompt);
  const cmd = parseCommand(promptText);
  if (cmd) {
    return handleCommand(
      {
        core: deps.core,
        conn: deps.conn,
        memoryStore: deps.memoryStore,
        buildSessionConfigOptions: (s) => buildSessionConfigOptions(deps, s),
      },
      params.sessionId,
      cmd,
    );
  }

  const response = await deps.core.prompt(
    params.sessionId,
    promptText,
    deps.conn,
    params.prompt,
  );

  deps.core.persistMessages(params.sessionId);
  maybeSetSessionTitle(deps.core, deps.conn, params.sessionId, promptText);
  return response;
};

export const cancel = async (
  deps: HandlerDeps,
  params: acp.CancelNotification,
) => {
  deps.core.cancel(params.sessionId);
};

export const authenticate = async (
  _deps: HandlerDeps,
  _params: acp.AuthenticateRequest,
) => ({});
