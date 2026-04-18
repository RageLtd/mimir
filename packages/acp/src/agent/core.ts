/**
 * Agent core — session management, model/mode switching, and prompt dispatch.
 *
 * Pure orchestration: delegates the actual prompt paths to prompt-server
 * and prompt-cc, which handle their own streaming and tool execution.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { BackendRouter } from "../backends";
import { promptViaClaudeCode } from "../backends/claude-code/prompt-cc";
import { loadRuleDetectors } from "../backends/claude-code/rule-hooks";
import {
  createAnchorState,
  type VoiceAnchor,
} from "../backends/claude-code/voice-anchors";
import type { Backend } from "../backends/types";
import type { CartographerManager } from "../cartographer/lifecycle";
import { formatRulesForPrompt, readProjectRules } from "../cartographer/rules";
import type { MimirConfig } from "../config";
import type { ContextClientConfig } from "../context-client";
import { resolveProjectForPath } from "../project/resolver";
import type { SessionStore } from "../store/sessions";
import type { UserMemoryStore } from "../store/user-memories";
import { errMessage } from "../util";
import { createChildLogger, log } from "../utils/log";
import { promptViaServer } from "./prompt-server";
import type { AgentCore, SessionState } from "./types";

/**
 * Default mode string for new sessions. Used as a backend-agnostic starting
 * point — CC will resolve it against `isValidCCMode` which accepts `"default"`;
 * server/Copilot don't read currentMode at all, so this is inert for them.
 */
const DEFAULT_MODE = "default";

export type AgentCoreDeps = {
  /** Parsed Voice in Action library used by the CC anchor wrapper. */
  readonly voiceAnchorLibrary: readonly VoiceAnchor[];
  /** Turns between anchor injections on the CC backend. */
  readonly anchorInterval: number;
};

const logger = createChildLogger(log, "core");

export const createAgentCore = (
  appConfig: MimirConfig,
  memoryStore: UserMemoryStore,
  router: BackendRouter,
  contextClient: ContextClientConfig,
  sessionStore: SessionStore,
  deps: AgentCoreDeps,
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
      projectId: null,
      projectInfo: null,
      abortController: null,
      currentModelId: appConfig.model,
      currentMode: DEFAULT_MODE,
      title: null,
      projectRules: null,
      ruleDetectors: [],
      clientMcpServers,
      supportsTerminalOutput,
      voiceAnchors: createAnchorState(
        sessionId,
        deps.voiceAnchorLibrary.length,
      ),
    };
    sessions.set(sessionId, session);

    // Load project rules asynchronously — they'll be ready by the first prompt
    readProjectRules(projectPath)
      .then((entries) => {
        session.projectRules = formatRulesForPrompt(entries);
      })
      .catch((err) => logger.warn("failed to load project rules:", err));

    // Load rule-detect sidecars asynchronously — advisory nudges wired into
    // the CC backend's PreToolUse hook on the first prompt.
    loadRuleDetectors(projectPath)
      .then((detectors) => {
        session.ruleDetectors = detectors;
      })
      .catch((err) => logger.warn("failed to load rule detectors:", err));

    // Resolve the canonical project UUID via git remote + server get-or-create.
    // Runs in parallel with other async session init; completes before the
    // first prompt in practice. Null result falls back to projectPath as the
    // server-facing identifier — preserves pre-resolver behaviour on failure.
    resolveProjectForPath(
      { serverUrl: appConfig.serverUrl, apiKey: appConfig.apiKey },
      projectPath,
    )
      .then((project) => {
        if (project) {
          session.projectId = project.id;
          session.projectInfo = project;
          sessionStore.updateMeta(sessionId, { projectId: project.id });
        }
      })
      .catch((err) =>
        logger.warn("project resolver failed: %s", errMessage(err)),
      );

    sessionStore.upsert(
      sessionId,
      projectPath,
      null,
      appConfig.model,
      DEFAULT_MODE,
      null,
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
      projectId: persisted.project_id,
      projectInfo: null,
      abortController: null,
      currentModelId: persisted.model_id,
      currentMode: persisted.mode,
      currentThoughtLevel:
        (persisted.thought_level as SessionState["currentThoughtLevel"]) ??
        undefined,
      title: persisted.title,
      projectRules: null,
      ruleDetectors: [],
      clientMcpServers,
      supportsTerminalOutput,
      voiceAnchors: createAnchorState(
        persisted.session_id,
        deps.voiceAnchorLibrary.length,
      ),
    };
    sessions.set(sessionId, session);

    // Load project rules asynchronously
    readProjectRules(persisted.project_path)
      .then((entries) => {
        session.projectRules = formatRulesForPrompt(entries);
      })
      .catch((err) => logger.warn("failed to load project rules:", err));

    loadRuleDetectors(persisted.project_path)
      .then((detectors) => {
        session.ruleDetectors = detectors;
      })
      .catch((err) => logger.warn("failed to load rule detectors:", err));

    // Re-resolve on restore so a renamed/moved project picks up changes and
    // so we backfill projectInfo (which isn't persisted). If persisted id is
    // already set, resolve will return the same record; negligible cost.
    resolveProjectForPath(
      { serverUrl: appConfig.serverUrl, apiKey: appConfig.apiKey },
      persisted.project_path,
    )
      .then((project) => {
        if (project) {
          session.projectId = project.id;
          session.projectInfo = project;
          if (project.id !== persisted.project_id) {
            sessionStore.updateMeta(sessionId, { projectId: project.id });
          }
        }
      })
      .catch((err) =>
        logger.warn("project re-resolve on restore failed: %s", errMessage(err)),
      );

    return session;
  };

  const getSession = (sessionId: string): SessionState | undefined =>
    sessions.get(sessionId);

  const listSessions = () => sessionStore.list();

  const setModel = (sessionId: string, modelId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.currentModelId = modelId;
    sessionStore.updateMeta(sessionId, { modelId });
    return true;
  };

  const compact = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.messages = [];
    sessionStore.updateMessages(sessionId, []);
    return true;
  };

  /**
   * Accepts any non-empty mode id. Validation against the backend's mode
   * catalogue happens one level up in `agent/index.ts:setSessionConfigOption`
   * where the active backend's config-options module is already in scope.
   * Keeping this method permissive avoids a cross-package import chain from
   * core.ts to backend-specific mode lists.
   */
  const setMode = (sessionId: string, modeId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (!modeId) return false;
    session.currentMode = modeId;
    sessionStore.updateMeta(sessionId, { mode: modeId });
    return true;
  };

  /**
   * Same permissiveness rationale as `setMode` — the backend's config-options
   * module is the authority on whether a given level is valid for the active
   * model, and that check lives in `agent/index.ts`.
   */
  const setThoughtLevel = (sessionId: string, level: string) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (!level) return false;
    session.currentThoughtLevel = level as SessionState["currentThoughtLevel"];
    sessionStore.updateMeta(sessionId, { thoughtLevel: level });
    return true;
  };

  const setTitle = (sessionId: string, title: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.title = title;
    sessionStore.updateMeta(sessionId, { title });
  };

  const persistMessages = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessionStore.updateMessages(sessionId, session.messages);
  };

  const prompt = async (
    sessionId: string,
    promptText: string,
    conn: acp.AgentSideConnection,
    promptBlocks?: readonly acp.ContentBlock[],
  ): Promise<acp.PromptResponse> => {
    const session = getSession(sessionId);
    if (!session) {
      logger.error("prompt: unknown session", sessionId);
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text" as const,
            text: "Error: session not found. Create a new session first.",
          },
        },
      });
      return { stopReason: "end_turn" as const };
    }
    const abortController = new AbortController();
    session.abortController = abortController;

    // Prepend a timestamp to the user's prompt so the model has ambient
    // awareness of when each turn happened. Persisted into session.messages
    // along with the original text — past turns keep their original stamps,
    // giving the model temporal context across the conversation.
    const stamp = new Date().toLocaleString("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      hour12: false,
    });

    const stampedPrompt = `[${stamp}]\n${promptText}`;

    let backend: Backend;
    try {
      backend = router.forModel(session.currentModelId);
    } catch (err) {
      const msg = errMessage(err);
      logger.error("Backend routing failed:", msg);
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text" as const, text: `Error: ${msg}` },
        },
      });
      return { stopReason: "end_turn" as const };
    }

    if (backend.kind === "claude-code") {
      return promptViaClaudeCode(
        session,
        stampedPrompt,
        conn,
        abortController,
        backend,
        contextClient,
        memoryStore,
        {
          library: deps.voiceAnchorLibrary,
          interval: deps.anchorInterval,
        },
        promptBlocks,
      );
    }
    return promptViaServer(
      session,
      stampedPrompt,
      conn,
      abortController,
      backend,
      appConfig,
      memoryStore,
      cartographer,
    );
  };

  const cancel = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session?.abortController) {
      session.abortController.abort();
    }
  };

  const dispose = () => {
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
    setThoughtLevel,
    setTitle,
    persistMessages,
    compact,
    prompt,
    cancel,
    dispose,
  };
};
