/**
 * PreToolUse hook output for hosts that speak Claude Code's hook
 * protocol (Claude Code itself, and Codex, whose hooks are a port).
 *
 * A blocking verdict becomes `permissionDecision: "deny"` with the
 * findings as the reason; advice rides along as `additionalContext`.
 * Null when the call is clean so the adapter can stay silent.
 */

import type { RuleVerdict } from "./runner";

export type PreToolUseOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision?: "deny";
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
};

export const preToolUseOutput = (verdict: RuleVerdict) => {
  if (verdict.block) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.block,
        ...(verdict.nudge ? { additionalContext: verdict.nudge } : {}),
      },
    } satisfies PreToolUseOutput;
  }
  if (verdict.nudge) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: verdict.nudge,
      },
    } satisfies PreToolUseOutput;
  }
  return null;
};

/** Combine per-call verdicts (a multi-file patch) into one. */
export const mergeVerdicts = (verdicts: ReadonlyArray<RuleVerdict>) => {
  const blocks = verdicts.map((v) => v.block).filter((b) => b !== null);
  const nudges = verdicts.map((v) => v.nudge).filter((n) => n !== null);
  return {
    block: blocks.length > 0 ? blocks.join("\n\n") : null,
    nudge: nudges.length > 0 ? nudges.join("\n\n") : null,
  } satisfies RuleVerdict;
};
