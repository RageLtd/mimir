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
import { isCCModel } from "../routing";
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
  cartographer?: CartographerManager | null,
): AgentCore => {
  const sessions = new Map<string, SessionState>();

  const newSession = (projectPath: string): SessionState => {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: SessionState = {
      sessionId,
      messages: [],
      projectPath,
      abortController: null,
      currentModelId: appConfig.model,
      currentMode: DEFAULT_MODE,
    };
    sessions.set(sessionId, session);
    return session;
  };

  const getSession = (sessionId: string): SessionState | undefined =>
    sessions.get(sessionId);

  const setModel = (sessionId: string, modelId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.currentModelId = modelId;
    // Switching to a non-CC model invalidates the CC --resume id; CC won't
    // be servicing this conversation any more, so any future CC turn
    // starts fresh.
    if (!isCCModel(modelId)) {
      session.ccSessionId = undefined;
    }
    return true;
  };

  const compact = (sessionId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.messages = [];
    // Reset CC session so the next CC prompt starts a fresh subprocess session
    // rather than trying to --resume a conversation that no longer exists here.
    session.ccSessionId = undefined;
    return true;
  };

  const setMode = (sessionId: string, modeId: string): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    const valid = SESSION_MODES.some((m) => m.id === modeId);
    if (!valid) return false;
    session.currentMode = modeId;
    return true;
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
    cartographer?.dispose();
  };

  return { newSession, setModel, setMode, compact, prompt, cancel, dispose };
};
