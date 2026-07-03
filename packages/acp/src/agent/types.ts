/**
 * Shared types for the agent module.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { ClientMcpManager } from "../client-mcp/manager";
import type { ResolvedProject } from "../project/resolver";
import type { LoadError, RuleEntry } from "../rules";
import type { ChatMessage } from "../server-client";

/** Reasoning effort levels the server backend accepts. */
export type ThoughtLevel = "none" | "low" | "medium" | "high";

export type SessionState = {
  sessionId: string;
  messages: ChatMessage[];
  projectPath: string;
  projectId: string | null;
  /**
   * Settles with the canonical project UUID once the resolver completes,
   * or null when resolution fails or the path can't be resolved. Cartographer
   * `autoIndex` awaits this before syncing so the index is always keyed by the
   * UUID rather than racing the resolver and falling back to path-keying — the
   * fragmentation that split one repo across two index records.
   */
  projectIdReady: Promise<string | null>;
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
  /** First turn only: assembleContext + boot server. */
  bootSequenceDone: boolean;
  /**
   * Server backend: tools whose permission the user permanently granted
   * via "Always Allow" in the client dialog. Persisted only in memory for
   * the session lifetime; restored sessions start fresh. Read/search tools
   * are auto-approved without prompting, so this Set typically only
   * contains state-mutating tools (edit, write, execute, delete).
   */
  permanentlyAllowedTools: Set<string>;
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
