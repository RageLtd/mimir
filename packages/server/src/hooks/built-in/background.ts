/**
 * Background task manager — PreToolUse + PostToolUse hook.
 *
 * Detects long-running shell commands (builds, tests, installs, linting)
 * and automatically backgrounds them with log file output. The PostToolUse
 * hook registers the task with the tracker and appends monitoring
 * instructions to the tool result so the model relays them.
 *
 * PreToolUse (modify): Rewrites matching commands to redirect output via
 * tee and run in the background.
 *
 * PostToolUse (result modification): Appends task tracking info to the
 * tool result so the model knows about the backgrounded task.
 */

import type { HookRegistry } from "../registry";
import { getTaskTracker } from "../task-tracker";
import type {
  HookContext,
  PostToolUseContext,
  PostToolUseResult,
  PreToolUseResult,
} from "../types";

// ---------------------------------------------------------------------------
// Long-running command patterns
// ---------------------------------------------------------------------------

interface LongRunningPattern {
  /** Regex to match against the bash command */
  pattern: RegExp;
  /** Task type category for tracking */
  taskType: string;
}

const LONG_RUNNING_PATTERNS: LongRunningPattern[] = [
  // Package installs — match BEFORE build patterns to avoid install
  // being swallowed by combined (build|test|install) alternations
  { pattern: /\bcargo\s+add\b/, taskType: "install" },
  { pattern: /\bnpm\s+install\b/, taskType: "install" },
  { pattern: /\bbun\s+(add|install)\b/, taskType: "install" },
  { pattern: /\byarn\s+(add|install)\b/, taskType: "install" },
  { pattern: /\bpnpm\s+(add|install)\b/, taskType: "install" },
  // Rust builds
  { pattern: /\bcargo\s+(build|check|clippy|test)\b/, taskType: "build" },
  // Node builds and tests (install handled above)
  { pattern: /\bnpm\s+(run\s+build|test)\b/, taskType: "build" },
  { pattern: /\bbun\s+(build|test)\b/, taskType: "build" },
  { pattern: /\byarn\s+(build|test)\b/, taskType: "build" },
  { pattern: /\bpnpm\s+(build|test|run\s+build)\b/, taskType: "build" },
  // Make / CMake
  { pattern: /\bmake\b/, taskType: "build" },
  { pattern: /\bcmake\s+--build\b/, taskType: "build" },
  // Docker
  { pattern: /\bdocker\s+(build|compose\s+up)\b/, taskType: "build" },
  // TypeScript type checking
  { pattern: /\btsc\b(?!.*--noEmit.*--watch)/, taskType: "lint" },
  // Linting
  { pattern: /\beslint\b.*\./, taskType: "lint" },
  { pattern: /\bbiome\s+(check|lint|format)\b/, taskType: "lint" },
];

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Check if a command is already backgrounded or redirected. */
function isAlreadyBackgrounded(command: string): boolean {
  // Already has & at end (backgrounded)
  if (/&\s*$/.test(command)) return true;
  // Uses nohup
  if (/\bnohup\b/.test(command)) return true;
  // Already has output redirection to a file
  if (/>\s*\S+/.test(command)) return true;
  // Already uses tee
  if (/\btee\b/.test(command)) return true;
  return false;
}

/** Detect the task type from a command string. Returns null if no match. */
export function detectTaskType(
  command: string,
): { taskType: string; pattern: LongRunningPattern } | null {
  for (const entry of LONG_RUNNING_PATTERNS) {
    if (entry.pattern.test(command)) {
      return { taskType: entry.taskType, pattern: entry };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metadata key for linking PreToolUse → PostToolUse
// ---------------------------------------------------------------------------

/** Internal metadata attached to modified args to link pre and post hooks. */
export interface BackgroundMeta {
  logPath: string;
  taskType: string;
  startedAt: number;
  originalCommand: string;
}

const BACKGROUND_META_KEY = "_background";

// ---------------------------------------------------------------------------
// PreToolUse hook
// ---------------------------------------------------------------------------

function backgroundPreHook(ctx: HookContext): PreToolUseResult {
  const command = ctx.args.command ?? ctx.args.cmd;
  if (typeof command !== "string" || !command) {
    return { action: "allow" };
  }

  // Don't rewrite if already backgrounded
  if (isAlreadyBackgrounded(command)) {
    return { action: "allow" };
  }

  const match = detectTaskType(command);
  if (!match) {
    return { action: "allow" };
  }

  const timestamp = Date.now();
  const logPath = `/tmp/mimir-${match.taskType}-${timestamp}.log`;

  const meta: BackgroundMeta = {
    logPath,
    taskType: match.taskType,
    startedAt: timestamp,
    originalCommand: command,
  };

  return {
    action: "modify",
    args: {
      ...ctx.args,
      command: `${command} 2>&1 | tee ${logPath} &`,
      [BACKGROUND_META_KEY]: meta,
    },
  };
}

// ---------------------------------------------------------------------------
// PostToolUse hook
// ---------------------------------------------------------------------------

function backgroundPostHook(ctx: PostToolUseContext): PostToolUseResult {
  const meta = ctx.args[BACKGROUND_META_KEY] as BackgroundMeta | undefined;
  if (!meta) return; // Not a backgrounded command

  const tracker = getTaskTracker();

  tracker.add({
    logPath: meta.logPath,
    taskType: meta.taskType,
    startedAt: meta.startedAt,
    fingerprint: ctx.fingerprint,
    command: meta.originalCommand,
  });

  // Append monitoring info to the tool result so the model can relay it
  const existingResult =
    typeof ctx.result === "string"
      ? ctx.result
      : JSON.stringify(ctx.result ?? "");

  const annotation = [
    `\n\n[Background Task Started]`,
    `Type: ${meta.taskType}`,
    `Log: ${meta.logPath}`,
    `Command: ${meta.originalCommand}`,
    ``,
    `This command has been backgrounded. To check progress:`,
    `  tail -20 ${meta.logPath}`,
    `Inform the developer that the task is running in the background.`,
    `Do not wait for it to complete — continue with other work.`,
  ].join("\n");

  return {
    result: existingResult + annotation,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBackgroundHook(registry: HookRegistry): void {
  // PreToolUse: detect and rewrite long-running commands
  registry.onPreToolUse(backgroundPreHook, {
    pattern: /^(bash|terminal|shell|run_command)$/,
  });

  // PostToolUse: register task and annotate result
  registry.onPostToolUse(backgroundPostHook, {
    pattern: /^(bash|terminal|shell|run_command)$/,
  });
}
