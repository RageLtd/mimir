/**
 * Shared types for the agent module.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { VoiceAnchorState } from "../backends/claude-code/voice-anchors";
import type { ReasoningEffort } from "../backends/codex/protocol/ReasoningEffort";
import type { BackendEvent } from "../backends/types";
import type { ClientMcpManager } from "../client-mcp/manager";
import type { ResolvedProject } from "../project/resolver";
import type { LoadError, RuleEntry } from "../rules";
import type { ChatMessage } from "../server-client";

export type ThoughtLevel = EffortLevel | ReasoningEffort;

export type CodexAppServerTurnOptions = {
  readonly prompt: string;
  readonly model: string;
  readonly effort?: ThoughtLevel;
  readonly signal?: AbortSignal;
};

export type CodexAppServerState = {
  readonly threadId: string;
  readonly close: () => Promise<void>;
  readonly runTurn: (
    options: CodexAppServerTurnOptions,
  ) => AsyncGenerator<BackendEvent>;
};

export type SessionState = {
  sessionId: string;
  messages: ChatMessage[];
  projectPath: string;
  projectId: string | null;
  projectInfo: ResolvedProject | null;
  abortController: AbortController | null;
  currentModelId: string;
  currentMode: string;
  currentThoughtLevel?: ThoughtLevel;
  title: string | null;
  projectRules: string | null;
  rules: readonly RuleEntry[];
  clientMcpServers?: readonly acp.McpServer[];
  clientSuppliedMcpServers?: readonly acp.McpServer[];
  clientMcp: ClientMcpManager | null;
  clientCapabilities: acp.ClientCapabilities;
  voiceAnchors: VoiceAnchorState;
  /** First turn only: assembleContext + boot server. Subsequent: SDK handles continuity. */
  bootSequenceDone: boolean;
  /**
   * Server backend: tools whose permission the user permanently granted
   * via "Always Allow" in the client dialog. Persisted only in memory for
   * the session lifetime; restored sessions start fresh. Read/search tools
   * are auto-approved without prompting, so this Set typically only
   * contains state-mutating tools (edit, write, execute, delete).
   */
  permanentlyAllowedTools: Set<string>;
  /**
   * CC backend: live Query handle from a streaming-input query(). Held across
   * ACP prompts so the subprocess and conversation state are reused instead of
   * rebuilt each turn. Null until the first prompt creates it; nulled on
   * compact/dispose and on effort changes (which require Query recreation
   * since the SDK has no setEffort).
   */
  ccQuery: Query | null;
  /**
   * CC backend: pushes a new SDKUserMessage into the long-lived async iterable
   * feeding ccQuery. Paired 1:1 with ccQuery — both null or both set.
   */
  ccUserStreamPush: ((msg: SDKUserMessage) => void) | null;
  /**
   * CC backend: long-lived BackendEvent stream from the streaming-input
   * Query. Paused between turns at the await on the SDK iterator. The
   * adapter drains it until each turn's `finish` event. Paired 1:1 with
   * ccQuery — both null or both set.
   */
  ccEvents: AsyncGenerator<BackendEvent> | null;
  /**
   * CC backend: snapshot of (modelId, mode, effort) at the time ccQuery was
   * created. Used by prompt-cc to detect mid-session changes and apply
   * setModel/setPermissionMode, or to recreate the Query when effort changes.
   */
  ccQueryConfig: {
    modelId: string;
    mode: string;
    effort: EffortLevel | undefined;
  } | null;
  codexAppServer: CodexAppServerState | null;
  codexInstructionPath: string | null;
  codexThreadConfig: {
    modelId: string;
    mode: string;
    effort: ThoughtLevel | undefined;
  } | null;
};

export type AgentCore = {
  newSession: (
    projectPath: string,
    clientMcpServers?: readonly acp.McpServer[],
    clientCapabilities?: acp.ClientCapabilities,
    onRuleErrors?: (errors: readonly LoadError[]) => void,
  ) => SessionState;
  restoreSession: (
    sessionId: string,
    clientMcpServers?: readonly acp.McpServer[],
    clientCapabilities?: acp.ClientCapabilities,
    onRuleErrors?: (errors: readonly LoadError[]) => void,
  ) => SessionState | null;
  getSession: (sessionId: string) => SessionState | undefined;
  listSessions: () => import("../store/sessions").PersistedSession[];
  setModel: (sessionId: string, modelId: string) => boolean;
  replaceMcpServers: (
    sessionId: string,
    newServers: readonly acp.McpServer[],
  ) => boolean;
  setMode: (sessionId: string, modeId: string) => boolean;
  setThoughtLevel: (sessionId: string, level: string) => boolean;
  setTitle: (sessionId: string, title: string) => void;
  persistMessages: (sessionId: string) => void;
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
