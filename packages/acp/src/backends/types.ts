/**
 * Backend abstraction.
 *
 * A Backend yields a normalized stream of BackendEvent values regardless of
 * whether inference happens on mimir-server (HTTP+SSE) or via the Claude
 * Code Agent SDK.
 *
 * Event semantics differ slightly per backend:
 *
 *   server backend
 *     - emits `tool_call` for each model-requested tool; the agent loop
 *       executes it (locally or via ACP forwarding) and feeds the result
 *       back. No `tool_result` is ever emitted by the backend.
 *
 *   claude-code backend
 *     - CC runs its own internal tool loop. We OBSERVE tool_use and
 *       tool_result events purely so the editor can show them; the
 *       agent loop must NOT execute them.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  McpSdkServerConfigWithInstance,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, ToolDefinition } from "../server-client";
import type { Detector } from "./claude-code/rule-hooks";

export type BackendEvent =
  | {
      readonly type: "init";
      readonly sessionId: string;
      readonly tools: readonly string[];
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      /** True when CC executes the tool itself; the agent loop must observe only. */
      readonly observeOnly: boolean;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly output: string;
      readonly observeOnly: boolean;
    }
  | {
      readonly type: "finish";
      readonly sessionId?: string;
      readonly stopReason?: string;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly cost?: number;
    }
  | { readonly type: "error"; readonly error: string };

export type BackendRunOptions = {
  /** Raw user prompt text for the current turn. */
  readonly prompt: string;
  /** Resolved system prompt (CC backend uses --system-prompt; server already has its own). */
  readonly systemPrompt: string;
  /** Full conversation history (server backend uses this). */
  readonly messages: readonly ChatMessage[];
  /** Tool manifest for the server backend; CC ignores it. */
  readonly tools: readonly ToolDefinition[];
  /** Project path (cwd for CC; metadata for server). */
  readonly projectPath: string;
  /**
   * Pre-assembled context messages for the CC backend (prior turns only —
   * the current user message goes as the SDK prompt input).
   * Formatted as structured text and concatenated into the system prompt.
   * Includes the server's context injection pair (summaries + memories)
   * and historical conversation turns.
   */
  readonly assembledMessages?: readonly {
    role: "user" | "assistant";
    content: string;
  }[];
  /** MCP servers provided by the ACP client to forward into CC's MCP config. */
  readonly clientMcpServers?: readonly McpServer[];
  /** In-process boot MCP server for delivering per-session context as tool results. */
  readonly bootServer?: McpSdkServerConfigWithInstance;
  /**
   * Raw ACP content blocks for the current turn.
   * Used by the CC backend to preserve image data in the SDK prompt input.
   * The server backend ignores this field.
   */
  readonly promptBlocks?: readonly ContentBlock[];
  readonly metadata: Record<string, unknown>;
  readonly signal?: AbortSignal;
  /** Resolved model id. CC backend uses this to derive --model. */
  readonly modelId: string;

  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  /**
   * Rule-detect sidecars for the CC backend's PreToolUse hook. Ignored by
   * backends other than claude-code. Passed through from the session state.
   */
  ruleDetectors?: readonly Detector[];
};

export type Backend = {
  readonly kind: "server" | "claude-code" | "copilot";
  readonly run: (options: BackendRunOptions) => AsyncGenerator<BackendEvent>;
};
