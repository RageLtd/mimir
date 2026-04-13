/**
 * Hook system types.
 *
 * Hooks intercept tool calls at defined lifecycle points, making
 * behavioral rules structurally enforceable rather than prompt-dependent.
 */

// ---------------------------------------------------------------------------
// Hook context
// ---------------------------------------------------------------------------

/** Context passed to every tool hook */
export interface HookContext {
  /** Tool being called */
  toolName: string;
  /** Tool arguments (parsed from schema) */
  args: Record<string, unknown>;
  /** Whether this is a server tool or client tool */
  toolType: "server" | "client";
  /** Current project path (if known) */
  project: string | null;
  /** Conversation fingerprint */
  fingerprint: string | null;
  /** Names of all tools available in the current request */
  availableTools?: string[];
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

/** Result of a PreToolUse hook */
export type PreToolUseResult =
  | { action: "allow" }
  | { action: "allow"; warning: string }
  | { action: "deny"; reason: string }
  | { action: "modify"; args: Record<string, unknown> };

/** PreToolUse hook — runs before a tool executes. Can allow, deny, or modify. */
export type PreToolUseHook = (
  ctx: HookContext,
) => PreToolUseResult | Promise<PreToolUseResult>;

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

/** Context for PostToolUse hooks, includes execution result and timing */
export interface PostToolUseContext extends HookContext {
  /** Tool execution result */
  result: unknown;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * PostToolUse result — optionally modify the tool result.
 * Return void/undefined to leave the result unchanged.
 * Return { result } to substitute the result the model sees.
 */
export type PostToolUseResult = undefined | { result: unknown };

/** PostToolUse hook — runs after a tool executes. Can observe or modify results. */
export type PostToolUseHook = (
  ctx: PostToolUseContext,
) => PostToolUseResult | Promise<PostToolUseResult>;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle events emitted at session-level points */
export type LifecycleEvent =
  | {
      type: "session_start";
      project: string | null;
      fingerprint: string | null;
    }
  | {
      type: "compaction_triggered";
      fingerprint: string;
      tokenCount: number;
    }
  | {
      type: "context_threshold";
      fingerprint: string;
      utilization: number;
    };

/** Lifecycle hook — fired on session-level events */
export type LifecycleHook = (event: LifecycleEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Filter which tools a hook applies to */
export interface ToolFilter {
  /** Exact tool names (match any) */
  names?: string[];
  /** Regex pattern against tool name */
  pattern?: RegExp;
  /** Tool type filter */
  type?: "server" | "client";
}
