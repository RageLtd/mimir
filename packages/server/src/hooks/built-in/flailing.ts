/**
 * Flailing detection hooks — PreToolUse interceptor + PostToolUse observer.
 *
 * The observer records tool calls into the FlailingTracker's rolling window.
 * The interceptor checks the flailing score before each tool call and
 * denies with a "step back and rethink" message when thresholds are crossed.
 *
 * Registration order matters:
 * - Interceptor must be registered AFTER destructive guard (safety first)
 * - Interceptor must be registered BEFORE audit (so denials are logged)
 * - Observer must be registered as PostToolUse
 */

import { config } from "../../config";
import { log } from "../../util/logger";
import {
  extractTarget,
  getFlailingTracker,
  isErrorResult,
  resultSnippet,
} from "../flailing-tracker";
import type { HookRegistry } from "../registry";
import type {
  HookContext,
  PostToolUseContext,
  PostToolUseResult,
  PreToolUseResult,
} from "../types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Score at which a nudge is injected (deny with rethink message). */
const NUDGE_THRESHOLD = config.flailing.nudgeThreshold;

/** Max nudges before a stronger denial message. */
const MAX_NUDGES = config.flailing.maxNudges;

// ---------------------------------------------------------------------------
// PostToolUse Observer
// ---------------------------------------------------------------------------

/**
 * Observer hook — records every tool call into the flailing tracker.
 * Runs on ALL tools (no filter). Never modifies the result.
 */
function flailingObserverHook(ctx: PostToolUseContext): PostToolUseResult {
  const tracker = getFlailingTracker();
  const sessionId = ctx.fingerprint ?? "default";

  tracker.record(sessionId, {
    toolName: ctx.toolName,
    target: extractTarget(ctx.toolName, ctx.args),
    resultSnippet: resultSnippet(ctx.result),
    isError: isErrorResult(ctx.result),
    at: Date.now(),
  });

  // Never modifies the result
  return undefined;
}

// ---------------------------------------------------------------------------
// PreToolUse Interceptor
// ---------------------------------------------------------------------------

/**
 * Interceptor hook — checks flailing score before each tool call.
 * Denies with a nudge message when score exceeds threshold.
 */
function flailingInterceptorHook(ctx: HookContext): PreToolUseResult {
  const tracker = getFlailingTracker();
  const sessionId = ctx.fingerprint ?? "default";
  const state = tracker.get(sessionId);
  const score = tracker.computeScore(sessionId);

  // Below nudge threshold — allow
  if (score < NUDGE_THRESHOLD) {
    return { action: "allow" };
  }

  // Above threshold — deny with a nudge message
  tracker.markNudged(sessionId);
  log.info(
    { sessionId, score, nudgeCount: state.nudgeCount },
    "flailing detected",
  );

  // Stronger message after repeated nudges
  if (state.nudgeCount >= MAX_NUDGES) {
    return {
      action: "deny",
      reason: [
        `You have been repeating similar tool calls ${state.nudgeCount} times without progress.`,
        "STOP and fundamentally change your approach.",
        "Review the error messages carefully, read the relevant documentation,",
        "or explain what you're stuck on so the developer can help.",
      ].join(" "),
    };
  }

  return {
    action: "deny",
    reason: [
      "You appear to be repeating similar tool calls without making progress.",
      "Take a step back and reconsider your approach.",
      "Check the relevant documentation or try a different strategy.",
    ].join(" "),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register flailing detection hooks.
 *
 * Order matters:
 * - PreToolUse interceptor runs AFTER destructive guard (safety first)
 * - PreToolUse interceptor runs BEFORE audit (so denials are logged)
 * - PostToolUse observer runs on every tool call
 */
export function registerFlailingHooks(registry: HookRegistry): void {
  // PreToolUse — interceptor (runs after destructive guard, before audit)
  registry.onPreToolUse(flailingInterceptorHook);

  // PostToolUse — observer (runs on every tool call)
  registry.onPostToolUse(flailingObserverHook);
}
