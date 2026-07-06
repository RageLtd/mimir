/**
 * Backend abstraction.
 *
 * A Backend yields a normalized stream of BackendEvent values from
 * mimir-server (HTTP+SSE). It emits `tool_call` for each model-requested
 * tool; the agent loop executes it (locally or via ACP forwarding) and
 * feeds the result back. No `tool_result` is ever emitted by the backend.
 *
 * The abstraction is intentionally backend-agnostic so additional
 * inference backends can be slotted in behind the same event contract.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { RuleEntry } from "@mimir/plugin-core/rules";
import type { SessionState, ThoughtLevel } from "../agent/types";
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
      /**
       * True when the backend executes the tool itself and the agent loop
       * must only observe (not re-execute). The server backend always sets
       * this false — its tool calls are real requests for the loop to run.
       */
      readonly observeOnly: boolean;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly output: string;
      readonly observeOnly: boolean;
    }
  | {
      readonly type: "tool_update";
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
       * The server backend sets this from the usage chunk's mimir extension
       * field; callers use it to advertise capacity after the turn. May be
       * undefined when the server omits it — callers then skip the emission.
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
  /** Resolved system prompt. */
  readonly systemPrompt: string;
  /** Full conversation history. */
  readonly messages: readonly ChatMessage[];
  /** Tool manifest advertised to the model. */
  readonly tools: readonly ToolDefinition[];
  /** Project path used as the working directory / metadata source. */
  readonly projectPath: string;
  /** MCP servers provided by the ACP client. */
  readonly clientMcpServers?: readonly McpServer[];
  /** Raw ACP content blocks for the current turn (preserves image data). */
  readonly promptBlocks?: readonly ContentBlock[];
  readonly metadata: Record<string, unknown>;
  readonly signal?: AbortSignal;
  /** Resolved model id. */
  readonly modelId: string;

  effort?: ThoughtLevel;
  /**
   * Loaded rule entries from the engine. The server backend intercepts
   * tool dispatch in prompt-server.ts. Empty array = no enforcement.
   */
  rules?: readonly RuleEntry[];
  /** Active session state, threaded through for backends that need it. */
  session?: SessionState;

  /**
   * Generic permission callback for gating tool execution. The server
   * backend calls it directly before executing each tool. Created once per
   * session via `createRequestToolPermission`.
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
  readonly kind: "server";
  readonly run: (options: BackendRunOptions) => AsyncGenerator<BackendEvent>;
};
