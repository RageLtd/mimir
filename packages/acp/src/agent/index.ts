/**
 * ACP Agent factory — the public entry point.
 *
 * Creates the ACP Agent implementation that Zed (or any ACP client)
 * connects to over stdio. Wires together session management, backend
 * routing, model/mode switching, and prompt dispatch.
 *
 * ACP session enrichment:
 *   - Session modes (code/ask/architect) via setSessionMode
 *   - Slash commands (/memory search, /memory list, etc.)
 *   - Thinking chunks streamed as agent_thought_chunk
 *   - Tool calls with kind, locations, and diff content
 *   - Incremental tool_call_update for status transitions
 *   - Embedded context (files, diagnostics) from editor
 */

import * as acp from "@agentclientprotocol/sdk";
import { createBackendRouter } from "../backends";
import {
  type CartographerManager,
  createCartographerManager,
} from "../cartographer/lifecycle";
import { config } from "../config";
import type { ContextClientConfig } from "../context-client";
import {
  ccAvailable,
  fetchServerModels,
  getCCModelList,
  mergeModels,
} from "../routing";
import { createUserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { formatContentBlocks } from "./content";
import { createAgentCore } from "./core";
import { AVAILABLE_COMMANDS, DEFAULT_MODE, SESSION_MODES } from "./session";

const logger = createChildLogger(log, "agent");

export const createMimirAgent = (conn: acp.AgentSideConnection): acp.Agent => {
  const memoryStore = createUserMemoryStore(config.userMemoryDbPath);
  const router = createBackendRouter(config);
  const contextClient: ContextClientConfig = {
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    systemPromptTtlMs: config.systemPromptTtlMs,
  };

  // Cartographer lifecycle — spawns the Rust binary as an MCP child
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
    contextClient,
    cartographer,
  );

  const buildModelsState = async (): Promise<acp.SessionModelState> => {
    const ccConfig = router.runtime.ccEnabled
      ? config.cc
      : { ...config.cc, enabled: false };
    const [serverModels, ccModels] = await Promise.all([
      fetchServerModels(config.serverUrl, config.apiKey),
      Promise.resolve(getCCModelList(ccConfig)),
    ]);
    const availableModels = mergeModels(serverModels, ccModels);
    return { availableModels, currentModelId: config.model };
  };

  return {
    async initialize(_params: acp.InitializeRequest) {
      // Resolve CC availability before accepting any prompts. If the
      // `claude` binary isn't on PATH, disable CC routing so users can't
      // pick a claude-code/* model that would crash on spawn.
      if (config.cc.enabled) {
        const available = await ccAvailable();
        router.runtime.ccEnabled = available;
        if (!available) {
          logger.info("claude binary not found on PATH; disabling CC backend");
        } else {
          logger.info("CC backend enabled");
        }
      } else {
        router.runtime.ccEnabled = false;
      }
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          promptCapabilities: {
            embeddedContext: true,
          },
        },
      };
    },

    async newSession(params: acp.NewSessionRequest) {
      // ACP spec: cwd MUST be an absolute path and MUST be used for the
      // session regardless of where the agent subprocess was spawned.
      const projectPath = params.cwd || process.cwd();
      const session = core.newSession(projectPath);
      logger.info("new session:", session.sessionId, "cwd:", projectPath);

      const models = await buildModelsState().catch((err) => {
        logger.warn("buildModelsState failed:", err);
        return undefined;
      });

      // Send available commands after session creation
      conn
        .sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: AVAILABLE_COMMANDS,
          },
        })
        .catch((err) => logger.warn("available_commands_update failed:", err));

      // Auto-index the project with cartographer (fire-and-forget)
      if (cartographer) {
        cartographer.autoIndex(projectPath);
      }

      return {
        sessionId: session.sessionId,
        ...(models ? { models } : {}),
        modes: {
          availableModes: SESSION_MODES,
          currentModeId: DEFAULT_MODE,
        },
      };
    },

    async unstable_setSessionModel(params: acp.SetSessionModelRequest) {
      const ok = core.setModel(params.sessionId, params.modelId);
      if (!ok) {
        logger.warn("setSessionModel: unknown session", params.sessionId);
      } else {
        logger.info("model set:", params.sessionId, "→", params.modelId);
      }
      return {};
    },

    async setSessionMode(params: acp.SetSessionModeRequest) {
      const ok = core.setMode(params.sessionId, params.modeId);
      if (!ok) {
        logger.warn(
          "setSessionMode: unknown session or invalid mode",
          params.sessionId,
          params.modeId,
        );
      } else {
        logger.info("mode set:", params.sessionId, "→", params.modeId);
        // Notify the editor of the mode change
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: params.modeId,
          },
        });
      }
      return {};
    },

    async authenticate(_params: acp.AuthenticateRequest) {},

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const promptText = formatContentBlocks(params.prompt);
      return core.prompt(params.sessionId, promptText, conn);
    },

    async cancel(params: acp.CancelNotification): Promise<void> {
      core.cancel(params.sessionId);
    },
  };
};
