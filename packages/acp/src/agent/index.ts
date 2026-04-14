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
import { createSessionStore } from "../store/sessions";
import { createUserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { formatContentBlocks } from "./content";
import { createAgentCore } from "./core";
import {
  AVAILABLE_COMMANDS,
  DEFAULT_MODE,
  type ParsedCommand,
  parseCommand,
  SESSION_MODES,
} from "./session";

const logger = createChildLogger(log, "agent");

export const createMimirAgent = (conn: acp.AgentSideConnection): acp.Agent => {
  const memoryStore = createUserMemoryStore(config.userMemoryDbPath);
  const sessionStore = createSessionStore(config.sessionDbPath);
  const router = createBackendRouter(config);
  const contextClient: ContextClientConfig = {
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    systemPromptTtlMs: config.systemPromptTtlMs,
  };

  // Captured from clientCapabilities during initialize — shared across sessions
  // on this connection (one connection = one Zed window).
  let supportsTerminalOutput = false;

  // Cartographer lifecycle — spawns the Rust binary as an MCP child
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
    cartographer,
  );

  // ── Command handler ──────────────────────────────────────────────────────
  // Executes a parsed slash command and streams a response back to the editor.
  // Returns a PromptResponse so the prompt handler can return it directly.

  const handleCommand = async (
    sessionId: string,
    cmd: ParsedCommand,
  ): Promise<acp.PromptResponse> => {
    const reply = async (text: string): Promise<void> => {
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    };

    switch (cmd.type) {
      case "model": {
        if (!cmd.modelId) {
          await reply("Usage: `/model <model-id>`");
          return { stopReason: "end_turn" };
        }
        const ok = core.setModel(sessionId, cmd.modelId);
        await reply(
          ok ? `Model switched to \`${cmd.modelId}\`.` : "Session not found.",
        );
        return { stopReason: "end_turn" };
      }

      case "mode": {
        if (!cmd.modeId) {
          const list = SESSION_MODES.map((m) => `\`${m.id}\``).join(", ");
          await reply(`Usage: \`/mode <id>\`\nAvailable modes: ${list}`);
          return { stopReason: "end_turn" };
        }
        const ok = core.setMode(sessionId, cmd.modeId);
        if (ok) {
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: cmd.modeId,
            },
          });
          await reply(`Mode switched to **${cmd.modeId}**.`);
        } else {
          const list = SESSION_MODES.map((m) => `\`${m.id}\``).join(", ");
          await reply(`Unknown mode \`${cmd.modeId}\`. Available: ${list}`);
        }
        return { stopReason: "end_turn" };
      }

      case "compact": {
        core.compact(sessionId);
        await reply("Session history cleared.");
        return { stopReason: "end_turn" };
      }

      case "memory_search": {
        if (!cmd.query) {
          await reply("Usage: `/memory search <query>`");
          return { stopReason: "end_turn" };
        }
        const results = memoryStore.searchMemories(cmd.query);
        if (results.length === 0) {
          await reply(`No memories found for "${cmd.query}".`);
        } else {
          const lines = results
            .map((m) => `[#${m.id}] ${m.content}`)
            .join("\n");
          await reply(`**Memory search**: "${cmd.query}"\n\n${lines}`);
        }
        return { stopReason: "end_turn" };
      }

      case "memory_list": {
        const memories = memoryStore.getMemories();
        if (memories.length === 0) {
          await reply("No memories stored.");
        } else {
          const lines = memories
            .map((m) => `[#${m.id}] ${m.content}`)
            .join("\n");
          await reply(`**Memories** (${memories.length})\n\n${lines}`);
        }
        return { stopReason: "end_turn" };
      }

      case "memory_store": {
        if (!cmd.fact) {
          await reply("Usage: `/memory store <fact>`");
          return { stopReason: "end_turn" };
        }
        const entry = memoryStore.addMemory(cmd.fact);
        await reply(`Memory stored [#${entry.id}]: "${entry.content}"`);
        return { stopReason: "end_turn" };
      }

      case "memory_delete": {
        const id = parseInt(cmd.id, 10);
        if (Number.isNaN(id)) {
          await reply("Usage: `/memory delete <id>`\nID must be a number.");
          return { stopReason: "end_turn" };
        }
        const deleted = memoryStore.deleteMemory(id);
        await reply(
          deleted ? `Memory #${id} deleted.` : `Memory #${id} not found.`,
        );
        return { stopReason: "end_turn" };
      }
    }
  };

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
    async initialize(params: acp.InitializeRequest) {
      // Capture terminal output capability — Zed advertises this when it can
      // render terminal widgets inside tool call chips.
      supportsTerminalOutput =
        params.clientCapabilities?._meta?.terminal_output === true;
      logger.info("terminal output supported:", supportsTerminalOutput);

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
          loadSession: true,
          promptCapabilities: {
            embeddedContext: true,
          },
          // Advertise that we accept HTTP and SSE MCP servers from the client.
          // Stdio servers are also accepted but aren't part of McpCapabilities.
          mcpCapabilities: {
            http: true,
            sse: true,
          },
          sessionCapabilities: {
            list: {},
          },
        },
      };
    },

    async newSession(params: acp.NewSessionRequest) {
      // ACP spec: cwd MUST be an absolute path and MUST be used for the
      // session regardless of where the agent subprocess was spawned.
      const projectPath = params.cwd || process.cwd();
      const session = core.newSession(
        projectPath,
        params.mcpServers,
        supportsTerminalOutput,
      );
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

    async loadSession(params: acp.LoadSessionRequest) {
      const session = core.restoreSession(
        params.sessionId,
        params.mcpServers,
        supportsTerminalOutput,
      );
      if (!session) {
        logger.warn("loadSession: unknown session", params.sessionId);
        // Return empty response — the client will likely fall back to newSession
        return {};
      }
      logger.info(
        "loadSession:",
        params.sessionId,
        `(${session.messages.length} messages)`,
      );

      const models = await buildModelsState().catch((err) => {
        logger.warn("buildModelsState failed:", err);
        return undefined;
      });

      // Re-advertise commands and current mode for this session
      conn
        .sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: AVAILABLE_COMMANDS,
          },
        })
        .catch((err) =>
          logger.warn("loadSession: available_commands_update failed:", err),
        );

      conn
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

      // Replay conversation history so the editor can render the transcript.
      // We emit user/assistant turns only — tool calls and thinking are not
      // replayed since the editor doesn't need them for display.
      for (const msg of session.messages) {
        if (msg.role === "user" && msg.content) {
          conn
            .sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: msg.content },
              },
            })
            .catch(() => {});
        } else if (msg.role === "assistant" && msg.content) {
          conn
            .sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: msg.content },
              },
            })
            .catch(() => {});
        }
      }

      // Restore the session title if we have one
      if (session.title) {
        conn
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

      return {
        ...(models ? { models } : {}),
        modes: {
          availableModes: SESSION_MODES,
          currentModeId: session.currentMode,
        },
      };
    },

    async listSessions(_params: acp.ListSessionsRequest) {
      const persisted = core.listSessions();
      return {
        sessions: persisted.map((s) => ({
          sessionId: s.session_id,
          cwd: s.project_path,
          title: s.title ?? undefined,
          updatedAt: s.updated_at,
        })),
      };
    },

    async authenticate(_params: acp.AuthenticateRequest) {},

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const promptText = formatContentBlocks(params.prompt);
      const cmd = parseCommand(promptText);
      if (cmd) return handleCommand(params.sessionId, cmd);

      const response = await core.prompt(
        params.sessionId,
        promptText,
        conn,
        params.prompt,
      );

      // Persist messages after each round-trip
      core.persistMessages(params.sessionId);

      // Generate and push a session title from the first user message if we
      // don't have one yet. We truncate to 60 chars to keep it readable in
      // Zed's session panel.
      const session = core.getSession(params.sessionId);
      if (session && !session.title) {
        const title = promptText.slice(0, 60).replace(/\s+/g, " ").trim();
        if (title) {
          core.setTitle(params.sessionId, title);
          conn
            .sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "session_info_update",
                title,
                updatedAt: new Date().toISOString(),
              },
            })
            .catch((err) => logger.warn("session_info_update failed:", err));
        }
      }

      return response;
    },

    async cancel(params: acp.CancelNotification): Promise<void> {
      core.cancel(params.sessionId);
    },
  };
};
