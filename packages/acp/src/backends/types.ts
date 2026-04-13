/**
 * Backend abstraction.
 *
 * A Backend yields a normalized stream of BackendEvent values regardless of
 * whether inference happens on mimir-server (HTTP+SSE) or via a local
 * Claude Code subprocess (NDJSON stream-json).
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

import type { McpServer } from "@agentclientprotocol/sdk";
import type { ChatMessage, ToolDefinition } from "../server-client";

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
   * Pre-assembled context for the CC backend.
   * When present, CC pipes this as stream-json NDJSON to stdin instead of
   * using prompt text. The array already includes the current user message
   * as its last entry.
   */
  readonly assembledMessages?: readonly {
    role: "user" | "assistant";
    content: string;
  }[];
  /** MCP servers provided by the ACP client to forward into CC's MCP config. */
  readonly clientMcpServers?: readonly McpServer[];
  readonly metadata: Record<string, unknown>;
  readonly signal?: AbortSignal;
  /** Resolved model id. CC backend uses this to derive --model. */
  readonly modelId: string;
};

export type Backend = {
  readonly kind: "server" | "claude-code";
  readonly run: (options: BackendRunOptions) => AsyncGenerator<BackendEvent>;
};
