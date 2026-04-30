/**
 * Shared types for the agent module.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Detector } from "../backends/claude-code/rule-hooks";
import type { VoiceAnchorState } from "../backends/claude-code/voice-anchors";
import type { ClientMcpManager } from "../client-mcp/manager";
import type { ResolvedProject } from "../project/resolver";
import type { ChatMessage } from "../server-client";

export type SessionState = {
  sessionId: string;
  messages: ChatMessage[];
  projectPath: string;
  /**
   * Canonical server-side project identifier. Resolved at session start
   * via git remote + POST /v1/projects/resolve; null when resolution
   * failed (caller falls back to projectPath as the identifier).
   */
  projectId: string | null;
  /**
   * Full project record returned by the server — title, git_remote,
   * technologies, etc. Available when projectId is set. Used for display
   * and for including as metadata in outgoing server calls.
   */
  projectInfo: ResolvedProject | null;
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
  /**
   * Rule-detect sidecars loaded from `.claude/rules/**\/*.detect.ts` at
   * session start. Advisory nudges are injected when violations are
   * detected — in the CC backend via PreToolUse hooks, in the server
   * backend by appending findings to the tool result. Empty array when
   * the project ships no sidecars.
   */
  ruleDetectors: readonly Detector[];
  /** MCP servers provided by the ACP client (e.g. Zed's ACP tools server). */
  clientMcpServers?: readonly acp.McpServer[];
  /**
   * Live MCP client connections for `clientMcpServers` entries — used by
   * the server backend path to expose those tools to mimir-server and
   * dispatch calls back through them. The CC backend ignores this; it
   * hands `clientMcpServers` directly to the Claude Agent SDK, which opens
   * its own connections. Null only for pre-existing sessions restored
   * before this field was introduced.
   */
  clientMcp: ClientMcpManager | null;
  /**
   * Capabilities advertised by the client during initialize.
   * Determines which client tools (fs_read_text_file, fs_write_text_file,
   * create_terminal) are offered to the model, and whether terminal output
   * is supported via _meta.terminal_*.
   */
  clientCapabilities: acp.ClientCapabilities;
  /**
   * Voice anchor rotation state for the CC backend. Counters tick once per
   * developer-initiated ACP prompt, never per SDK tool-result turn. Unused
   * for the mimir-server backend path.
   */
  voiceAnchors: VoiceAnchorState;
  /**
   * One-shot flag — when true, the next CC `query()` invocation runs with
   * `continue: false` so the Claude Agent SDK opens a fresh session (and
   * fresh MCP connections). Cleared after that turn. The SDK doesn't
   * handle `notifications/tools/list_changed` mid-session, so this is the
   * mechanism for picking up newly-available tools after an MCP server
   * completes OAuth or otherwise changes its tool advertisement.
   * Triggered by the `/reload-mcp` slash command. Unused for non-CC
   * backends.
   */
  ccNeedsFreshSession?: boolean;
};

export type AgentCore = {
  newSession: (
    projectPath: string,
    clientMcpServers?: readonly acp.McpServer[],
    clientCapabilities?: acp.ClientCapabilities,
  ) => SessionState;
  /**
   * Restore a previously persisted session into the in-memory map.
   * Returns the restored SessionState, or null if the sessionId is unknown.
   */
  restoreSession: (
    sessionId: string,
    clientMcpServers?: readonly acp.McpServer[],
    clientCapabilities?: acp.ClientCapabilities,
  ) => SessionState | null;
  getSession: (sessionId: string) => SessionState | undefined;
  listSessions: () => import("../store/sessions").PersistedSession[];
  setModel: (sessionId: string, modelId: string) => boolean;
  /**
   * Flag the session so the next CC turn runs `query()` with `continue:
   * false` — used by `/reload-mcp` to pick up newly-available MCP tools
   * after a server completes OAuth. No-op when the session is unknown or
   * routed to a non-CC backend.
   */
  markCcNeedsFreshSession: (sessionId: string) => boolean;
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
