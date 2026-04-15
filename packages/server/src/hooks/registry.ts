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

function matchesFilter(ctx: HookContext, filter?: ToolFilter) {
  if (!filter) return true;

  if (filter.type && filter.type !== ctx.toolType) return false;

  if (filter.names && !filter.names.includes(ctx.toolName)) return false;

  if (filter.pattern && !filter.pattern.test(ctx.toolName)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface HookRegistry {
  onPreToolUse(hook: PreToolUseHook, filter?: ToolFilter): void;
  onPostToolUse(hook: PostToolUseHook, filter?: ToolFilter): void;
  onLifecycle(hook: LifecycleHook): void;
  runPreHooks(ctx: HookContext): Promise<PreToolUseResult>;
  runPostHooks(ctx: PostToolUseContext): Promise<unknown>;
  emitLifecycle(event: LifecycleEvent): Promise<void>;
  readonly stats: { pre: number; post: number; lifecycle: number };
}

export function createHookRegistry(): HookRegistry {
  const preHooks: PreEntry[] = [];
  const postHooks: PostEntry[] = [];
  const lifecycleHooks: LifecycleHook[] = [];

  return {
    onPreToolUse(hook, filter) {
      preHooks.push({ hook, filter });
    },

    onPostToolUse(hook, filter) {
      postHooks.push({ hook, filter });
    },

    onLifecycle(hook) {
      lifecycleHooks.push(hook);
    },

    async runPreHooks(ctx) {
      let currentArgs = ctx.args;
      let lastWarning: string | undefined;

      for (const entry of preHooks) {
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
          } catch (logErr) {
            console.error("pre-hook error (logger also failed):", err, logErr);
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
    },

    async runPostHooks(ctx) {
      let currentResult = ctx.result;

      for (const entry of postHooks) {
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
            log.error(
              { err, tool: ctx.toolName },
              "post-hook threw, continuing",
            );
          } catch (logErr) {
            console.error("post-hook error (logger also failed):", err, logErr);
          }
        }
      }

      return currentResult;
    },

    async emitLifecycle(event) {
      for (const hook of lifecycleHooks) {
        try {
          await hook(event);
        } catch (err) {
          log.error({ err, event: event.type }, "lifecycle hook threw");
        }
      }
    },

    get stats() {
      return {
        pre: preHooks.length,
        post: postHooks.length,
        lifecycle: lifecycleHooks.length,
      };
    },
  };
}
