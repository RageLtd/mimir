/**
 * Hook registry — manages registration and execution of hooks.
 *
 * Execution rules:
 * - PreToolUse hooks run in registration order
 * - First "deny" short-circuits (remaining hooks skipped)
 * - "modify" results are cumulative (each hook sees prior modifications)
 * - PostToolUse hooks run in registration order, always
 * - PostToolUse hooks can optionally modify the result
 */

import { log } from "../util/logger";
import type {
  HookContext,
  LifecycleEvent,
  LifecycleHook,
  PostToolUseContext,
  PostToolUseHook,
  PostToolUseResult,
  PreToolUseHook,
  PreToolUseResult,
  ToolFilter,
} from "./types";

// ---------------------------------------------------------------------------
// Registered hook entry (hook + optional filter)
// ---------------------------------------------------------------------------

interface PreEntry {
  hook: PreToolUseHook;
  filter?: ToolFilter;
}

interface PostEntry {
  hook: PostToolUseHook;
  filter?: ToolFilter;
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

function matchesFilter(ctx: HookContext, filter?: ToolFilter): boolean {
  if (!filter) return true;

  if (filter.type && filter.type !== ctx.toolType) return false;

  if (filter.names && !filter.names.includes(ctx.toolName)) return false;

  if (filter.pattern && !filter.pattern.test(ctx.toolName)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class HookRegistry {
  private preHooks: PreEntry[] = [];
  private postHooks: PostEntry[] = [];
  private lifecycleHooks: LifecycleHook[] = [];

  /** Register a PreToolUse hook with an optional tool filter. */
  onPreToolUse(hook: PreToolUseHook, filter?: ToolFilter): void {
    this.preHooks.push({ hook, filter });
  }

  /** Register a PostToolUse hook with an optional tool filter. */
  onPostToolUse(hook: PostToolUseHook, filter?: ToolFilter): void {
    this.postHooks.push({ hook, filter });
  }

  /** Register a lifecycle hook. */
  onLifecycle(hook: LifecycleHook): void {
    this.lifecycleHooks.push(hook);
  }

  /**
   * Run all matching PreToolUse hooks.
   *
   * - First "deny" short-circuits and returns immediately.
   * - "modify" results are cumulative — each subsequent hook sees the
   *   modified args from previous hooks.
   * - If all hooks return "allow", the final result is "allow".
   */
  async runPreHooks(ctx: HookContext): Promise<PreToolUseResult> {
    let currentArgs = ctx.args;
    let lastWarning: string | undefined;

    for (const entry of this.preHooks) {
      if (!matchesFilter(ctx, entry.filter)) continue;

      try {
        const result = await entry.hook({ ...ctx, args: currentArgs });

        if (result.action === "deny") {
          log.info(
            {
              tool: ctx.toolName,
              reason: result.reason,
            },
            "hook denied tool call",
          );
          return result;
        }

        if (
          result.action === "allow" &&
          "warning" in result &&
          result.warning
        ) {
          log.warn(
            { tool: ctx.toolName, warning: result.warning },
            "tool hierarchy warning",
          );
          lastWarning = result.warning;
        }

        if (result.action === "modify") {
          currentArgs = result.args;
        }
      } catch (err) {
        try {
          log.error(
            { err, tool: ctx.toolName },
            "pre-hook threw, treating as allow",
          );
        } catch {
          // Logger itself failed (e.g. fd closed in tests)
        }
      }
    }

    // If any hook modified args, return a modify result
    if (currentArgs !== ctx.args) {
      return { action: "modify", args: currentArgs };
    }

    if (lastWarning) {
      return { action: "allow", warning: lastWarning };
    }

    return { action: "allow" };
  }

  /**
   * Run all matching PostToolUse hooks.
   *
   * Hooks run in order. If any hook returns a { result } object,
   * the modified result is passed to subsequent hooks and returned.
   * If no hook modifies the result, returns the original.
   */
  async runPostHooks(ctx: PostToolUseContext): Promise<unknown> {
    let currentResult = ctx.result;

    for (const entry of this.postHooks) {
      if (!matchesFilter(ctx, entry.filter)) continue;

      try {
        const hookResult: PostToolUseResult = await entry.hook({
          ...ctx,
          result: currentResult,
        });

        if (hookResult && "result" in hookResult) {
          currentResult = hookResult.result;
        }
      } catch (err) {
        try {
          log.error({ err, tool: ctx.toolName }, "post-hook threw, continuing");
        } catch {
          // Logger itself failed
        }
      }
    }

    return currentResult;
  }

  /** Emit a lifecycle event to all registered lifecycle hooks. */
  async emitLifecycle(event: LifecycleEvent): Promise<void> {
    for (const hook of this.lifecycleHooks) {
      try {
        await hook(event);
      } catch (err) {
        log.error({ err, event: event.type }, "lifecycle hook threw");
      }
    }
  }

  /** Number of registered hooks (for diagnostics). */
  get stats() {
    return {
      pre: this.preHooks.length,
      post: this.postHooks.length,
      lifecycle: this.lifecycleHooks.length,
    };
  }
}
