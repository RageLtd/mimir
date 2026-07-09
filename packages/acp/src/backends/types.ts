/**
 * Backend abstraction.
 *
 * A Backend yields a normalized stream of BackendEvent values from one
 * local model turn (MIM-89 — inference runs in-process on the plugin-core
 * engine). It emits `tool_call` for each model-requested tool; the agent
 * loop executes it (locally or via ACP forwarding) and feeds the result
 * back by re-invoking `run` with updated history. The backend never
 * executes tools itself — the observe-only leg died with the server
 * backend.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { RuleEntry } from "@mimir/plugin-core/rules";
import type { ToolDefinition } from "@mimir/plugin-core/tools/user-memory";
import type { ChatMessage, SessionState, ThoughtLevel } from "../agent/types";

export type BackendEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "finish";
      readonly stopReason?: string;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly cost?: number;
      /**
       * Total context window for the model used on this turn, in tokens.
       * Read from the local provider registry's model metadata; callers
       * use it to advertise capacity after the turn. May be undefined when
       * the catalogue omits it — callers then skip the emission.
       */
      readonly contextWindow?: number;
    }
  | { readonly type: "error"; readonly error: string };

export type BackendRunOptions = {
  /** Raw user prompt text for the current turn. */
  readonly prompt: string;
  /** Resolved system prompt. */
  readonly systemPrompt: string;
  /**
   * Full conversation history for the turn, with the synthetic context
   * injection pair (when any) already prepended by the host. The backend
   * adds only the system message ahead of these.
   */
  readonly messages: readonly ChatMessage[];
  /** Tool manifest advertised to the model. */
  readonly tools: readonly ToolDefinition[];
  /** Project path used as the working directory / metadata source. */
  readonly projectPath: string;
  /** MCP servers provided by the ACP client. */
  readonly clientMcpServers?: readonly McpServer[];
  /** Raw ACP content blocks for the current turn (preserves image data). */
  readonly promptBlocks?: readonly ContentBlock[];
  readonly signal?: AbortSignal;
  /** Resolved model id. */
  readonly modelId: string;

  effort?: ThoughtLevel;
  /**
   * Loaded rule entries from the engine. The agent loop intercepts
   * tool dispatch in prompt-server.ts. Empty array = no enforcement.
   */
  rules?: readonly RuleEntry[];
  /** Active session state, threaded through for backends that need it. */
  session?: SessionState;

  /**
   * Generic permission callback for gating tool execution. The agent loop
   * calls it directly before executing each tool. Created once per
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
  readonly kind: "local";
  readonly run: (options: BackendRunOptions) => AsyncGenerator<BackendEvent>;
};
