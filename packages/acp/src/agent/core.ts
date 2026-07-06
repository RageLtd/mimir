/**
 * Agent core — session management, model/mode switching, and prompt dispatch.
 *
 * Pure orchestration: delegates the actual prompt paths to prompt-server
 * and prompt-cc, which handle their own streaming and tool execution.
 */

import type * as acp from "@agentclientprotocol/sdk";
import {
  collectProjectMetadata,
  detectGitRemote,
  patchProjectMetadata,
  type ResolvedProject,
  resolveProjectForPath,
} from "@mimir/plugin-core/project";
import { type LoadError, loadRules } from "@mimir/plugin-core/rules";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { errMessage } from "@mimir/plugin-core/util";
import type { BackendRouter } from "../backends";
import type { CartographerManager } from "../cartographer/lifecycle";
import { formatRulesForPrompt, readProjectRules } from "../cartographer/rules";
import { createClientMcpManager } from "../client-mcp/manager";
import type { MimirConfig } from "../config";
import type { SessionStore } from "../store/sessions";
import { createChildLogger, log } from "../utils/log";
import { emitAgentText } from "./lifecycle-helpers";
import { promptViaServer } from "./prompt-server";
import type { SessionState } from "./types";

/**
 * Default mode string for new sessions. The server backend does not yet
 * read currentMode, so this is an inert placeholder until server-side
 * modes are wired in.
 */
const DEFAULT_MODE = "default";

const logger = createChildLogger(log, "core");

/**
 * Kick off the three async loaders that hydrate a session's
 * project-derived state (rules, rule-detect sidecars, canonical project
 * UUID). Each runs independently and writes its result back to `session`
 * when ready. Errors are logged at warn level and don't propagate — the
 * session is usable without these completing, just with reduced features
 * (no rule context in the prompt, no detector advisory nudges, falls back
 * to projectPath as the server-facing identifier).
 *
 * Called from both `newSession` (with `onResolved` to persist the project
 * UUID) and `restoreSession` (with `onResolved` that only persists when
 * the resolved id changed). Centralising it here means the shape of
 * "what makes a session ready" lives in one place.
 */
const kickOffSessionInit = (
  session: SessionState,
  projectPath: string,
  serverUrl: string,
  apiKey: string,
  onResolved: (project: ResolvedProject) => void,
  settleProjectId: (id: string | null) => void,
  onRuleErrors?: (errors: readonly LoadError[]) => void,
) => {
  readProjectRules(projectPath)
    .then((entries) => {
      session.projectRules = formatRulesForPrompt(entries);
    })
    .catch((err) => logger.warn("failed to load project rules:", err));

  // Eager rule loading + error surfacing. Successful entries land in
  // `session.rules`; any LoadErrors get handed to `onRuleErrors` (the
  // agent layer wires this to a session_update so the developer sees
  // every broken `.enforce.toml` once at session start, not when the
  // rule should have fired).
  loadRules(projectPath)
    .then(({ rules, errors }) => {
      session.rules = rules;
      if (errors.length > 0) {
        logger.warn(
          { count: errors.length, projectPath },
          "rule loader surfaced errors",
        );
        if (onRuleErrors) onRuleErrors(errors);
      }
    })
    .catch((err) => logger.warn("failed to load rules:", err));

  detectGitRemote(projectPath)
    .then((gitRemote) =>
      resolveProjectForPath(serverUrl, apiKey, projectPath, gitRemote),
    )
    .then(async (project) => {
      if (!project) {
        // Resolution returned nothing — settle so autoIndex stops waiting
        // and syncs under the filesystem path (the server's back-compat key).
        settleProjectId(null);
        return;
      }
      onResolved(project);
      // Settle before the metadata PATCH so a slow second round-trip never
      // delays the index sync.
      settleProjectId(project.id);

      // Collect metadata from manifest files and PATCH unconditionally —
      // the project entity is the source of truth and should reflect the
      // current state of the filesystem on every session start.
      const metadata = await collectProjectMetadata(projectPath);
      if (metadata.technologies.length > 0 || metadata.description) {
        await patchProjectMetadata(serverUrl, apiKey, project.id, metadata);
      }
    })
    .catch((err) => {
      settleProjectId(null);
      logger.warn("project resolver failed: %s", errMessage(err));
    });
};

export const createAgentCore = (
  appConfig: MimirConfig,
  memoryStore: UserMemoryStore,
  router: BackendRouter,
  sessionStore: SessionStore,
  cartographer?: CartographerManager | null,
) => {
  const sessions = new Map<string, SessionState>();

  const newSession = (
    projectPath: string,
    clientMcpServers?: readonly acp.McpServer[],
    clientCapabilities: acp.ClientCapabilities = {},
    onRuleErrors?: (errors: readonly LoadError[]) => void,
  ) => {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let settleProjectId: (id: string | null) => void = () => {};
    const projectIdReady = new Promise<string | null>((resolve) => {
      settleProjectId = resolve;
    });
    const session: SessionState = {
      sessionId,
      messages: [],
      projectPath,
      projectId: null,
      projectIdReady,
      projectInfo: null,
      abortController: null,
      currentModelId: appConfig.model,
      currentMode: DEFAULT_MODE,
      title: null,
      projectRules: null,
      rules: [],
      clientMcpServers,
      clientMcp: createClientMcpManager(sessionId, clientMcpServers),
      clientCapabilities,
      bootSequenceDone: false,
      permanentlyAllowedTools: new Set(),
    };
    sessions.set(sessionId, session);

    kickOffSessionInit(
      session,
      projectPath,
      appConfig.serverUrl,
      appConfig.apiKey,
      (project) => {
        session.projectId = project.id;
        session.projectInfo = project;
        sessionStore.updateMeta(sessionId, { projectId: project.id });
      },
      settleProjectId,
      onRuleErrors,
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

  const replaceMcpServers = (
    sessionId: string,
    newServers: readonly acp.McpServer[],
  ) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.clientMcpServers === newServers) return true;
    session.clientMcp
      ?.close()
      .catch((err) => logger.debug("clientMcp.close on rebuild failed:", err));
    session.clientMcp = createClientMcpManager(sessionId, newServers);
    session.clientMcpServers = newServers;
    return true;
  };

  const restoreSession = (
    sessionId: string,
    clientMcpServers?: readonly acp.McpServer[],
    clientCapabilities: acp.ClientCapabilities = {},
    onRuleErrors?: (errors: readonly LoadError[]) => void,
  ) => {
    // Already live in this process — just update runtime fields.
    // If the caller replaces the MCP server list we rebuild the manager
    // so the new connection set reflects the new config.
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.clientMcpServers !== clientMcpServers) {
        replaceMcpServers(sessionId, clientMcpServers ?? []);
      }
      existing.clientCapabilities = clientCapabilities;
      return existing;
    }
    const persisted = sessionStore.get(sessionId);
    if (!persisted) return null;
    let settleProjectId: (id: string | null) => void = () => {};
    const projectIdReady = new Promise<string | null>((resolve) => {
      settleProjectId = resolve;
    });
    const session: SessionState = {
      sessionId: persisted.session_id,
      messages: JSON.parse(persisted.messages),
      projectPath: persisted.project_path,
      projectId: persisted.project_id,
      projectIdReady,
      projectInfo: null,
      abortController: null,
      currentModelId: persisted.model_id,
      currentMode: persisted.mode,
      currentThoughtLevel:
        (persisted.thought_level as SessionState["currentThoughtLevel"]) ??
        undefined,
      title: persisted.title,
      projectRules: null,
      rules: [],
      clientMcpServers,
      clientMcp: createClientMcpManager(persisted.session_id, clientMcpServers),
      clientCapabilities,
      bootSequenceDone: false,
      permanentlyAllowedTools: new Set(),
    };
    sessions.set(sessionId, session);

    // Re-resolve on restore so a renamed/moved project picks up changes
    // and so we backfill projectInfo (which isn't persisted). The
    // onResolved callback only writes to disk when the id has changed —
    // negligible cost when it matches.
    kickOffSessionInit(
      session,
      persisted.project_path,
      appConfig.serverUrl,
      appConfig.apiKey,
      (project) => {
        session.projectId = project.id;
        session.projectInfo = project;
        if (project.id !== persisted.project_id) {
          sessionStore.updateMeta(sessionId, { projectId: project.id });
        }
      },
      settleProjectId,
      onRuleErrors,
    );

    return session;
  };

  const getSession = (sessionId: string) => sessions.get(sessionId);

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
    // Wipe mimir's transcript record and reset the boot flag so the next
    // prompt re-runs the boot sequence against whatever recent messages /
    // summaries the server now provides.
    session.messages = [];
    sessionStore.updateMessages(sessionId, []);
    session.bootSequenceDone = false;
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
  ) => {
    const session = getSession(sessionId);
    if (!session) {
      logger.error("prompt: unknown session", sessionId);
      await emitAgentText(
        conn,
        sessionId,
        "Error: session not found. Create a new session first.",
      );
      return { stopReason: "refusal" as const };
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

    const route = router.forModel(session.currentModelId);
    if (!route.ok) {
      logger.error("Backend routing failed:", route.error);
      await emitAgentText(conn, sessionId, `Error: ${route.error}`);
      return { stopReason: "refusal" as const };
    }
    const backend = route.backend;

    const result = await promptViaServer({
      session,
      promptText: stampedPrompt,
      conn,
      abortController,
      backend,
      appConfig,
      memoryStore,
      cartographer,
      promptBlocks,
    });

    // Reindex after any turn that modified files so Cartographer queries
    // reflect the current state on the next prompt.
    if (result.filesModified && cartographer && session.projectPath) {
      cartographer.autoIndex(session.projectPath, session.projectIdReady);
    }

    return result;
  };

  const cancel = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    // abortController.abort() is the cross-backend signal; the CC adapter
    // listens for it and calls q.interrupt() to stop the current turn
    // without tearing down the long-lived subprocess. The server backend
    // uses the same signal to cancel its in-flight HTTP request.
    session.abortController?.abort();
  };

  const dispose = () => {
    for (const session of sessions.values()) {
      session.abortController?.abort();
      session.clientMcp
        ?.close()
        .catch((err) =>
          logger.debug("clientMcp.close on dispose failed:", err),
        );
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
    replaceMcpServers,
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
