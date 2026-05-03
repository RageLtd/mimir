/**
 * Claude Code backend rule-detector adapter.
 *
 * Thin wrapper over the backend-agnostic rule engine in `packages/acp/
 * src/rules/`. The CC backend wires rule enforcement via the SDK's
 * PreToolUse hook: this module exposes one function — `buildRuleHook`
 * — that turns a list of `RuleEntry` (from `loadRules`) into a hook
 * matcher the SDK consumes.
 *
 * All other concerns — discovery, parsing, regex compilation,
 * matching, formatting — live in the engine. Server-backend has its
 * own adapter under `backends/server/rule-intercept.ts` that consumes
 * the same engine.
 */
import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { type RuleEntry, runAndFormat } from "../../rules";

/**
 * Build a PreToolUse hook matcher list from loaded rules. Returns the
 * shape the SDK's `hooks.PreToolUse` option accepts. Empty rules
 * array still returns a matcher (which always no-ops) — the formatting
 * caller decides whether to attach hooks at all.
 */
export const buildRuleHook = (rules: readonly RuleEntry[]) => {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const } };
    }
    const ctx = buildContext(input);
    const nudge = await runAndFormat(rules, ctx);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        ...(nudge ? { additionalContext: nudge } : {}),
      },
    };
  };
  return [{ hooks: [hook] }];
};

/**
 * Translate a `PreToolUseHookInput` into the engine's
 * `DetectorContext`. The SDK delivers `tool_input` as `unknown`
 * (because it varies per tool); we narrow defensively and pass an
 * empty object on shape mismatch — the engine then no-ops gracefully
 * because none of its field extractors find the values they need.
 *
 * `cwd` from the hook event is the session's project root, matching
 * the engine's expectation for builtin detectors that resolve relative
 * paths (e.g. file-length reading the on-disk file).
 */
const buildContext = (input: PreToolUseHookInput) => ({
  toolName: input.tool_name,
  toolInput:
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : ({} as Record<string, unknown>),
  projectPath: input.cwd,
});
