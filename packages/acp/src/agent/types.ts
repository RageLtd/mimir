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
  /** CC session id for --resume, set after the first CC init event. */
  ccSessionId?: string;
  /** Current session mode (code/ask/architect). */
  currentMode: string;
};

export type AgentCore = {
  newSession: (projectPath: string) => SessionState;
  setModel: (sessionId: string, modelId: string) => boolean;
  setMode: (sessionId: string, modeId: string) => boolean;
  /** Clear session message history and reset the CC session id. */
  compact: (sessionId: string) => boolean;
  prompt: (
    sessionId: string,
    promptText: string,
    conn: acp.AgentSideConnection,
  ) => Promise<acp.PromptResponse>;
  cancel: (sessionId: string) => void;
  dispose: () => void;
};
