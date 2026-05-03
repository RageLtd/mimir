/**
 * Shared types for the agent module.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { VoiceAnchorState } from "../backends/claude-code/voice-anchors";
import type { ClientMcpManager } from "../client-mcp/manager";
import type { ResolvedProject } from "../project/resolver";
import type { LoadError, RuleEntry } from "../rules";
import type { ChatMessage } from "../server-client";

export type SessionState = {
  sessionId: string;
  messages: ChatMessage[];
  projectPath: string;
  projectId: string | null;
  projectInfo: ResolvedProject | null;
  abortController: AbortController | null;
  currentModelId: string;
  currentMode: string;
  currentThoughtLevel?: EffortLevel;
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
