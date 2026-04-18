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
import { checkForSdkUpdate } from "../backends/claude-code/sdk-updater";
import type { CartographerManager } from "../cartographer/lifecycle";
import type { MimirConfig } from "../config";
import {
  ccAvailable,
  discoverCCModelsViaSdk,
  discoverCopilotModels,
} from "../routing";
import type { UserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { handleCommand } from "./commands";
import { formatContentBlocks } from "./content";
import {
  buildModelConfigOption,
  buildModelsState,
  buildSessionConfigOptions,
  ccAliasFor,
  type ModelResolutionDeps,
} from "./model-resolution";
import { AVAILABLE_COMMANDS, parseCommand } from "./session";
import type { AgentCore } from "./types";

const logger = createChildLogger(log, "handlers");

export type HandlerDeps = ModelResolutionDeps & {
  readonly core: AgentCore;
  readonly conn: acp.AgentSideConnection;
  readonly config: MimirConfig;
  readonly router: BackendRouter;
  readonly memoryStore: UserMemoryStore;
  readonly cartographer: CartographerManager | null;
  readonly getSupportsTerminalOutput: () => boolean;
  readonly setSupportsTerminalOutput: (v: boolean) => void;
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
): Promise<acp.InitializeResponse> => {
  const { config, router } = deps;
  deps.setSupportsTerminalOutput(
    params.clientCapabilities?._meta?.terminal_output === true,
  );
  logger.info("terminal output supported:", deps.getSupportsTerminalOutput());

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

const fetchModelsState = async (deps: HandlerDeps) =>
  buildModelsState(deps).catch((err) => {
    logger.warn("buildModelsState failed:", err);
    return undefined;
  });

const emitCommandsList = (deps: HandlerDeps, sessionId: string) => {
  deps.conn
    .sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: AVAILABLE_COMMANDS,
      },
    })
    .catch((err) => logger.warn("available_commands_update failed:", err));
};

/** Emit the commands list once per session. Called from newSession
 *  (deferred via setTimeout(0) so the response is sent first) and
 *  loadSession. Deduplication via commandsEmitted prevents double-sends
 *  when both paths hit the same session. */
const maybeEmitCommandsList = (deps: HandlerDeps, sessionId: string) => {
  if (deps.commandsEmitted.has(sessionId)) return;
  deps.commandsEmitted.add(sessionId);
  emitCommandsList(deps, sessionId);
};

export const newSession = async (
  deps: HandlerDeps,
  params: acp.NewSessionRequest,
): Promise<acp.NewSessionResponse> => {
  const projectPath = params.cwd || process.cwd();
  const session = deps.core.newSession(
    projectPath,
    params.mcpServers,
    deps.getSupportsTerminalOutput(),
  );
  logger.info("new session:", session.sessionId, "cwd:", projectPath);

  const models = await fetchModelsState(deps);
  // getProjectId is read at sync time — the resolver runs in parallel with
  // session init, so the UUID may be unavailable now but populated by the
  // time cartographer actually posts the index.
  deps.cartographer?.autoIndex(projectPath, () => session.projectId);

  // Sync session.currentModelId with whatever buildModelsState auto-selected,
  // so the in-memory state matches what Zed renders in the picker.
  if (models?.currentModelId) {
    deps.core.setModel(session.sessionId, models.currentModelId);
  }

  // Compose the full configOptions list: backend-native mode + thought_level
  // selectors first, model selector last. Zed's newer UI reads model
  // selection from configOptions with category "model" when any
  // configOptions are present, so we always include it when models are
  // available — otherwise the picker disappears.
  const backendOptions = buildSessionConfigOptions(deps, session);
  const configOptions =
    models && models.availableModels.length > 0 && models.currentModelId
      ? [...backendOptions, buildModelConfigOption(models)]
      : backendOptions;
  logger.info("newSession configOptions:", configOptions.length, "entries");

  // Emit available_commands_update after all async work completes so the
  // notification is sent on the next macrotask — after the SDK has flushed
  // the session/new response as a microtask. Placing this before the first
  // await races the client, which hasn't registered the session yet and
  // discards the notification as "failed to get session".
  setTimeout(() => maybeEmitCommandsList(deps, session.sessionId), 0);

  return {
    sessionId: session.sessionId,
    ...(models ? { models } : {}),
    ...(configOptions.length > 0 ? { configOptions } : {}),
  };
};

const replayHistoryToEditor = (
  deps: HandlerDeps,
  sessionId: string,
  messages: readonly { role: string; content: string | null }[],
) => {
  for (const msg of messages) {
    if (msg.role === "user" && msg.content) {
      deps.conn
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: msg.content },
          },
        })
        .catch(() => {});
    } else if (msg.role === "assistant" && msg.content) {
      deps.conn
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: msg.content },
          },
        })
        .catch(() => {});
    }
  }
};

export const loadSession = async (
  deps: HandlerDeps,
  params: acp.LoadSessionRequest,
): Promise<acp.LoadSessionResponse> => {
  const session = deps.core.restoreSession(
    params.sessionId,
    params.mcpServers,
    deps.getSupportsTerminalOutput(),
  );
  if (!session) {
    logger.warn("loadSession: unknown session", params.sessionId);
    return {};
  }
  logger.info(
    "loadSession:",
    params.sessionId,
    `(${session.messages.length} messages)`,
  );

  const models = await fetchModelsState(deps);
  maybeEmitCommandsList(deps, params.sessionId);

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

  replayHistoryToEditor(deps, params.sessionId, session.messages);

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
      .catch(() => {});
  }

  const backendOptions = buildSessionConfigOptions(deps, session);
  const configOptions =
    models && models.availableModels.length > 0 && models.currentModelId
      ? [...backendOptions, buildModelConfigOption(models)]
      : backendOptions;
  logger.info("loadSession configOptions:", configOptions.length, "entries");
  return {
    ...(models ? { models } : {}),
    ...(configOptions.length > 0 ? { configOptions } : {}),
  };
};

export const listSessions = async (
  deps: HandlerDeps,
  _params: acp.ListSessionsRequest,
): Promise<acp.ListSessionsResponse> => {
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
): Promise<acp.SetSessionModelResponse> => {
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
  return {};
};

export const setSessionMode = async (
  deps: HandlerDeps,
  params: acp.SetSessionModeRequest,
): Promise<acp.SetSessionModeResponse> => {
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
    .catch(() => {});
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
): Promise<acp.SetSessionConfigOptionResponse> => {
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

  // Recompute the full configOptions including the refreshed model selector
  // (the thought-level entries may have changed if the model switched).
  const models = await fetchModelsState(deps);
  const backendOptions = buildSessionConfigOptions(deps, session);
  const configOptions =
    models && models.availableModels.length > 0 && models.currentModelId
      ? [...backendOptions, buildModelConfigOption(models)]
      : backendOptions;
  logger.info(
    "setSessionConfigOption configOptions:",
    configOptions.length,
    "entries",
  );
  return { configOptions };
};

// ── prompt ──────────────────────────────────────────────────────────────────

const maybeSetSessionTitle = (
  deps: HandlerDeps,
  sessionId: string,
  promptText: string,
) => {
  const session = deps.core.getSession(sessionId);
  if (!session || session.title) return;
  const title = promptText.slice(0, 60).replace(/\s+/g, " ").trim();
  if (!title) return;
  deps.core.setTitle(sessionId, title);
  deps.conn
    .sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      },
    })
    .catch((err) => logger.warn("session_info_update failed:", err));
};

export const prompt = async (
  deps: HandlerDeps,
  params: acp.PromptRequest,
): Promise<acp.PromptResponse> => {
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
  maybeSetSessionTitle(deps, params.sessionId, promptText);
  return response;
};

export const cancel = async (
  deps: HandlerDeps,
  params: acp.CancelNotification,
): Promise<void> => {
  deps.core.cancel(params.sessionId);
};

export const authenticate = async (
  _deps: HandlerDeps,
  _params: acp.AuthenticateRequest,
): Promise<acp.AuthenticateResponse> => ({});
