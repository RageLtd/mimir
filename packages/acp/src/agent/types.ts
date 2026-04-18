/**
 * Shared types for the agent module.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { VoiceAnchorState } from "../backends/claude-code/voice-anchors";
import type { ChatMessage } from "../server-client";

export type SessionState = {
  sessionId: string;
  messages: ChatMessage[];
  projectPath: string;
  abortController: AbortController | null;
  /** Currently selected model id (drives backend routing per request). */
  currentModelId: string;
  /**
   * Current session mode. Backend-specific — e.g. for CC this is a
   * `PermissionMode` value like "default" / "plan" / "acceptEdits". Other
   * backends that don't advertise modes store the empty string here.
   */
  currentMode: string;
  /**
   * Current thought-level (effort) selection, for backends that support it.
   * CC populates this from `ModelInfo.supportedEffortLevels` per model.
   * Server/Copilot leave it undefined.
   */
  currentThoughtLevel?: EffortLevel;
  /** Human-readable title, generated from the first exchange and persisted. */
  title: string | null;
  /** Formatted project rules (CLAUDE.md, .claude/rules/, etc.) for prompt injection. */
  projectRules: string | null;
  /** MCP servers provided by the ACP client (e.g. Zed's ACP tools server). */
  clientMcpServers?: readonly acp.McpServer[];
  /**
   * Whether the ACP client supports terminal output via _meta.terminal_*.
   * Set from clientCapabilities._meta.terminal_output during initialize.
   */
  supportsTerminalOutput: boolean;
  /**
   * Voice anchor rotation state for the CC backend. Counters tick once per
   * developer-initiated ACP prompt, never per SDK tool-result turn. Unused
   * for the mimir-server backend path.
   */
  voiceAnchors: VoiceAnchorState;
};

export type AgentCore = {
  newSession: (
    projectPath: string,
    clientMcpServers?: readonly acp.McpServer[],
    supportsTerminalOutput?: boolean,
  ) => SessionState;
  /**
   * Restore a previously persisted session into the in-memory map.
   * Returns the restored SessionState, or null if the sessionId is unknown.
   */
  restoreSession: (
    sessionId: string,
    clientMcpServers?: readonly acp.McpServer[],
    supportsTerminalOutput?: boolean,
  ) => SessionState | null;
  getSession: (sessionId: string) => SessionState | undefined;
  listSessions: () => import("../store/sessions").PersistedSession[];
  setModel: (sessionId: string, modelId: string) => boolean;
  setMode: (sessionId: string, modeId: string) => boolean;
  setThoughtLevel: (sessionId: string, level: string) => boolean;
  setTitle: (sessionId: string, title: string) => void;
  /** Flush current message history to the session store. */
  persistMessages: (sessionId: string) => void;
  /** Clear session message history. */
  compact: (sessionId: string) => boolean;
  prompt: (
    sessionId: string,
    promptText: string,
    conn: acp.AgentSideConnection,
    promptBlocks?: readonly acp.ContentBlock[],
  ) => Promise<acp.PromptResponse>;
  cancel: (sessionId: string) => void;
  dispose: () => void;
};
