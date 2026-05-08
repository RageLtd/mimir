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
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionState } from "../agent/types";
import type { RuleEntry } from "../rules";
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
      /**
       * Total context window for the model used on this turn, in tokens.
       * Set by the CC backend from `SDKResultMessage.modelUsage[*].contextWindow`
       * — the SDK's authoritative per-model max. Other backends may leave
       * this undefined; callers fall back to a cached value or skip the
       * advertised-size emission entirely.
       */
      readonly contextWindow?: number;
      /**
       * Non-success error details from the underlying turn-boundary message
       * (e.g. SDKResultMessage.errors when subtype !== "success"). Consumers
       * use this together with stopReason to surface human-readable causes
       * for refusals; absent on a successful turn.
       */
      readonly errors?: readonly string[];
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
  /** MCP servers provided by the ACP client to forward into CC's MCP config. */
  readonly clientMcpServers?: readonly McpServer[];
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
   * Loaded rule entries from the engine. CC backend wires them into a
   * PreToolUse hook; server backend intercepts tool dispatch in
   * prompt-server.ts. Empty array = no enforcement.
   */
  rules?: readonly RuleEntry[];
  /**
   * The CC backend uses this to manage the long-lived streaming-input
   * Query stored on `SessionState.ccQuery`: first turn creates it,
   * subsequent turns push new SDKUserMessages into the existing stream.
   * Other backends ignore this field.
   */
  session?: SessionState;

  /**
   * Generic permission callback for gating tool execution. The CC backend
   * wraps this into the SDK's `CanUseTool` shape; the server backend can
   * call it directly before executing each tool. Created once per session
   * via `createRequestToolPermission`.
   */
  requestToolPermission?: RequestToolPermission;
};

// ---------------------------------------------------------------------------
// Generic tool-permission abstraction (backend-agnostic)
// ---------------------------------------------------------------------------

export type ToolPermissionRequest = {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly toolCallId: string;
  readonly title?: string;
  readonly description?: string;
};

export type ToolPermissionResult = {
  readonly allowed: boolean;
  readonly message?: string;
  /** Whether this decision should persist for the remainder of the session. */
  readonly permanent?: boolean;
};

/**
 * Callback that prompts the user for permission before executing a tool.
 * Created once per session via `createRequestToolPermission` and threaded
 * through `BackendRunOptions` so every backend can use it.
 */
export type RequestToolPermission = (
  request: ToolPermissionRequest,
) => Promise<ToolPermissionResult>;

export type Backend = {
  readonly kind: "server" | "claude-code" | "copilot";
  readonly run: (options: BackendRunOptions) => AsyncGenerator<BackendEvent>;
};
