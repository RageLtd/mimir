/**
 * Destructive action guard — PreToolUse hook.
 *
 * Pattern-matches bash commands against known destructive operations
 * and denies them with an instruction to ask the developer first.
 * After N consecutive denials for the same action, escalates with a
 * stronger message.
 *
 * Integrates with the ApprovalTracker: if the developer has approved
 * a specific action (via the approve_action server tool), the hook
 * allows it through and clears the denial counter.
 */

import { approvalKey, getApprovalTracker } from "../approval";
import { DenialTracker } from "../denial-tracker";
import type { HookRegistry } from "../registry";
import type { HookContext, PreToolUseResult } from "../types";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

interface DestructivePattern {
  /** Regex to match against the bash command string */
  pattern: RegExp;
  /** Human-readable description of what this catches */
  description: string;
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git — hard to reverse
  {
    pattern: /git\s+push\s+.*--force/,
    description: "force push (can overwrite remote history)",
  },
  {
    pattern: /git\s+push\s+-f\b/,
    description: "force push (can overwrite remote history)",
  },
  {
    pattern: /git\s+reset\s+--hard/,
    description: "hard reset (discards uncommitted changes)",
  },
  {
    pattern: /git\s+branch\s+-[dD]\s/,
    description: "branch deletion",
  },
  {
    pattern: /git\s+checkout\s+\.\s*$/,
    description: "discard all uncommitted changes",
  },
  {
    pattern: /git\s+clean\s+-f/,
    description: "remove untracked files",
  },
  {
    pattern: /git\s+stash\s+drop/,
    description: "permanently discard stashed changes",
  },
  // Git — skip safety checks
  {
    pattern: /--no-verify/,
    description: "skip git hooks (safety bypass)",
  },
  // File — destructive
  {
    pattern: /\brm\s+-rf\s/,
    description: "recursive force delete",
  },
  {
    pattern: /\brm\s+.*-r\b/,
    description: "recursive delete",
  },
  // Process — irreversible
  {
    pattern: /\bkill\s+-9\s/,
    description: "force kill process",
  },
  {
    pattern: /\bpkill\b/,
    description: "kill processes by name",
  },
  {
    pattern: /\bkillall\b/,
    description: "kill all processes by name",
  },
  // Database — destructive
  {
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    description: "drop database object",
  },
  {
    pattern: /\bTRUNCATE\s+TABLE\b/i,
    description: "truncate table",
  },
];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function matchDestructivePattern(command: string): DestructivePattern | null {
  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(command)) {
      return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

function createDestructiveGuardHook(tracker: DenialTracker) {
  return function destructiveGuardHook(ctx: HookContext): PreToolUseResult {
    const command = ctx.args.command ?? ctx.args.cmd;
    if (typeof command !== "string" || !command) {
      return { action: "allow" };
    }

    const match = matchDestructivePattern(command);
    if (!match) {
      return { action: "allow" };
    }

    // Check if the developer has already approved this action
    const key = approvalKey(ctx.toolName, ctx.args);
    const approvalTracker = getApprovalTracker();
    if (approvalTracker.isApproved(key, ctx.fingerprint)) {
      // Approved — clear denial counter and allow
      tracker.clearSpecific(ctx.toolName, ctx.args, ctx.fingerprint);
      return { action: "allow" };
    }

    const { exceeded, count } = tracker.recordDenial(
      ctx.toolName,
      ctx.args,
      ctx.fingerprint,
    );

    if (exceeded) {
      return {
        action: "deny",
        reason: [
          `BLOCKED: ${match.description}.`,
          `This action has been denied ${count} times consecutively.`,
          `You MUST ask the developer for explicit approval before attempting this action again.`,
          `Present the exact command and explain why it's needed.`,
          `Once the developer approves, call approve_action with the exact command, then retry.`,
        ].join(" "),
      };
    }

    return {
      action: "deny",
      reason: [
        `This is a destructive action (${match.description}) that requires explicit developer approval.`,
        `Present your plan and the exact command to the developer, explain why it's needed, and wait for approval.`,
        `Once approved, call approve_action with the exact command, then retry.`,
      ].join(" "),
    };
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Denial tracker instance — created per registration, exposed for testing/approval flow */
let activeTracker: DenialTracker | null = null;

export function registerDestructiveHook(registry: HookRegistry): void {
  const tracker = new DenialTracker();
  activeTracker = tracker;

  const hook = createDestructiveGuardHook(tracker);

  registry.onPreToolUse(hook, {
    pattern: /^bash$/,
    type: "server",
  });

  // Also catch client-side bash tools
  registry.onPreToolUse(hook, {
    pattern: /^(bash|terminal|shell|run_command)$/,
    type: "client",
  });
}

/** Clear denial records for a conversation (call on developer approval) */
export function clearDenials(fingerprint: string | null): void {
  activeTracker?.clearForConversation(fingerprint);
}
