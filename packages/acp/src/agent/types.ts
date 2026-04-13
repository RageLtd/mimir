/**
 * Shared types for the agent module.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { ChatMessage } from "../server-client";

export type SessionState = {
  sessionId: string;
  messages: ChatMessage[];
  projectPath: string;
  abortController: AbortController | null;
  /** Currently selected model id (drives backend routing per request). */
  currentModelId: string;
  /** Current session mode (code/ask/architect). */
  currentMode: string;
  /** MCP servers provided by the ACP client (e.g. Zed's ACP tools server). */
  clientMcpServers?: readonly acp.McpServer[];
  /**
   * Whether the ACP client supports terminal output via _meta.terminal_*.
   * Set from clientCapabilities._meta.terminal_output during initialize.
   */
  supportsTerminalOutput: boolean;
};

export type AgentCore = {
  newSession: (
    projectPath: string,
    clientMcpServers?: readonly acp.McpServer[],
    supportsTerminalOutput?: boolean,
  ) => SessionState;
  setModel: (sessionId: string, modelId: string) => boolean;
  setMode: (sessionId: string, modeId: string) => boolean;
  /** Clear session message history. */
  compact: (sessionId: string) => boolean;
  prompt: (
    sessionId: string,
    promptText: string,
    conn: acp.AgentSideConnection,
  ) => Promise<acp.PromptResponse>;
  cancel: (sessionId: string) => void;
  dispose: () => void;
};
