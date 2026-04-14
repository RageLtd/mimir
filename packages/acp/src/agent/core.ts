/**
 * Agent core — session management, model/mode switching, and prompt dispatch.
 *
 * Pure orchestration: delegates the actual prompt paths to prompt-server
 * and prompt-cc, which handle their own streaming and tool execution.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { BackendRouter } from "../backends";
import type { Backend } from "../backends/types";
import type { CartographerManager } from "../cartographer/lifecycle";
import type { MimirConfig } from "../config";
import type { ContextClientConfig } from "../context-client";
import type { SessionStore } from "../store/sessions";
import type { UserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { promptViaClaudeCode } from "./prompt-cc";
import { promptViaServer } from "./prompt-server";
import { DEFAULT_MODE, SESSION_MODES } from "./session";
import type { AgentCore, SessionState } from "./types";

const logger = createChildLogger(log, "core");

export const createAgentCore = (
  appConfig: MimirConfig,
  memoryStore: UserMemoryStore,
  router: BackendRouter,
  contextClient: ContextClientConfig,
  sessionStore: SessionStore,
  cartographer?: CartographerManager | null,
): AgentCore => {
  const sessions = new Map<string, SessionState>();

  const newSession = (
    projectPath: string,
    clientMcpServers?: readonly acp.McpServer[],
    supportsTerminalOutput = false,
  ): SessionState => {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: SessionState = {
      sessionId,
      messages: [],
      projectPath,
      abortController: null,
      currentModelId: appConfig.model,
      currentMode: DEFAULT_MODE,
      title: null,
      clientMcpServers,
      supportsTerminalOutput,
    };
    sessions.set(sessionId, session);
    sessionStore.upsert(
      sessionId,
      projectPath,
      appConfig.model,
      DEFAULT_MODE,
      null,
      [],
    );
    return session;
  };

  const restoreSession = (
    sessionId: string,
    clientMcpServers?: readonly acp.McpServer[],
    supportsTerminalOutput = false,
  ): SessionState | null => {
    // Already live in this process — just update runtime fields
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.clientMcpServers = clientMcpServers;
      existing.supportsTerminalOutput = supportsTerminalOutput;
      return existing;
    }
    const persisted = sessionStore.get(sessionId);
    if (!persisted) return null;
    const session: SessionState = {
      sessionId: persisted.session_id,
      messages: JSON.parse(persisted.messages),
      projectPath: persisted.project_path,
      abortController: null,
      currentModelId: persisted.model_id,
      currentMode: persisted.mode,
      title: persisted.title,
      clientMcpServers,
      supportsTerminalOutput,
    };
    sessions.set(sessionId, session);
    return session;
  };

  const getSession = (sessionId: string): SessionState | undefined =>
    sessions.get(sessionId);

  const listSessions = () => sessionStore.list();

  const setModel = (sessionId: string, modelId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.currentModelId = modelId;
    sessionStore.updateMeta(sessionId, { modelId });
    return true;
  };

  const compact = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.messages = [];
    sessionStore.updateMessages(sessionId, []);
    return true;
  };

  const setMode = (sessionId: string, modeId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    const valid = SESSION_MODES.some((m) => m.id === modeId);
    if (!valid) return false;
    session.currentMode = modeId;
    sessionStore.updateMeta(sessionId, { mode: modeId });
    return true;
  };

  const setTitle = (sessionId: string, title: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.title = title;
    sessionStore.updateMeta(sessionId, { title });
  };

  const persistMessages = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessionStore.updateMessages(sessionId, session.messages);
  };

  const prompt = async (
    sessionId: string,
    promptText: string,
    conn: acp.AgentSideConnection,
  ): Promise<acp.PromptResponse> => {
    const session = getSession(sessionId);
    if (!session) {
      logger.error("prompt: unknown session", sessionId);
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Error: session not found. Create a new session first.",
          },
        },
      });
      return { stopReason: "end_turn" };
    }
    const abortController = new AbortController();
    session.abortController = abortController;

    let backend: Backend;
    try {
      backend = router.forModel(session.currentModelId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Backend routing failed:", msg);
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Error: ${msg}` },
        },
      });
      return { stopReason: "end_turn" };
    }

    if (backend.kind === "claude-code") {
      return promptViaClaudeCode(
        session,
        promptText,
        conn,
        abortController,
        backend,
        contextClient,
        memoryStore,
      );
    }
    return promptViaServer(
      session,
      promptText,
      conn,
      abortController,
      backend,
      appConfig,
      memoryStore,
      cartographer,
    );
  };

  const cancel = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (session?.abortController) {
      session.abortController.abort();
    }
  };

  const dispose = (): void => {
    for (const session of sessions.values()) {
      session.abortController?.abort();
    }
    memoryStore.close();
    sessionStore.close();
    cartographer?.dispose();
  };

  return {
    newSession,
    restoreSession,
    getSession,
    listSessions,
    setModel,
    setMode,
    setTitle,
    persistMessages,
    compact,
    prompt,
    cancel,
    dispose,
  };
};
