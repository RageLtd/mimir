/**
 * Backend-agnostic rule runner. Ported verbatim from
 * packages/acp/src/rules/runner.ts.
 *
 * `runRules(rules, ctx)` walks every loaded rule, filters by event +
 * file-glob scope, evaluates conditions / negative_conditions or
 * dispatches to a builtin detector, and returns a list of `Finding`
 * the formatter renders for the model.
 *
 * The plugin's PreToolUse adapter (rules-hook.ts) builds a
 * `DetectorContext` from the CC hook payload and calls this. The runner
 * does not know about hooks, SSE, or which tool-execution mechanism is
 * in play — it operates on rule data.
 */

import * as path from "node:path";
import { Glob } from "bun";
import { resolveBuiltin } from "./builtins";
import { applyMessageTemplate, formatFindings } from "./format";
import {
  type ConditionMatch,
  evaluateCondition,
  resolveField,
} from "./matcher";
import type {
  CompiledCondition,
  DetectorContext,
  Finding,
  RuleEntry,
  Violation,
} from "./types";

/**
 * Map a hookify event to the set of backend-native tool names that
 * trigger it. Each backend's adapter passes its own native tool name
 * in `DetectorContext.toolName`; the runner uses this map to decide
 * whether a rule applies.
 *
 * `all` matches every tool. `stop` and `prompt` are session-lifecycle
 * events without a corresponding tool name — adapters that need them
 * pass a synthetic `toolName` of `__stop__` / `__prompt__` so the
 * mapping stays declarative.
 */
const EVENT_TO_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set(["Bash", "create_terminal", "terminal"]),
  file: new Set([
    "Edit",
    "Write",
    "MultiEdit",
    "fs_write_text_file",
    "write_text_file",
  ]),
  stop: new Set(["__stop__"]),
  prompt: new Set(["__prompt__"]),
};

/** True when a rule's `event` covers the current tool-call. */
export const eventMatchesTool = (event: string, toolName: string) => {
  if (event === "all") return true;
  const tools = EVENT_TO_TOOLS[event];
  return tools ? tools.has(toolName) : false;
};

/**
 * True when the file path is excluded by the rule's `exclude_globs`.
 * Globs are evaluated with Bun's `Glob` against the path's basename
 * AND the full absolute path, so both `*.test.ts` and
 * `**\/*.test.ts` style patterns work.
 */
const matchesExcludeGlob = (
  excludeGlobs: readonly string[],
  filePath: string,
) => {
  for (const pattern of excludeGlobs) {
    const glob = new Glob(pattern);
    if (glob.match(filePath)) return true;
    if (glob.match(path.basename(filePath))) return true;
  }
  return false;
};

/**
 * Run all rules against a tool-call context. Returns the list of
 * findings (one entry per rule that produced violations). Adapters
 * pass the result to `formatFindings` — runner returns structured
 * data so adapters can also render to non-text surfaces (e.g.
 * structured tool_call_update notifications).
 */
export const runRules = async (
  rules: ReadonlyArray<RuleEntry>,
  ctx: DetectorContext,
) => {
  const findings: Finding[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!eventMatchesTool(rule.event, ctx.toolName)) continue;

    if (rule.excludeGlobs && rule.excludeGlobs.length > 0) {
      const filePath = resolveField("file_path", ctx);
      if (filePath && matchesExcludeGlob(rule.excludeGlobs, filePath)) {
        continue;
      }
    }

    const violations = await evaluateRule(rule, ctx);
    if (violations.length > 0) {
      findings.push({ rule, violations });
    }
  }

  return findings;
};

/**
 * Per-rule evaluation. Builtin detectors get full control over what
 * counts as a violation and what message it carries. Regex-based rules
 * AND-join their conditions, AND-NOT-join their negative_conditions,
 * and apply the rule's `message` template (when set) to each surfaced
 * violation.
 */
const evaluateRule = async (rule: RuleEntry, ctx: DetectorContext) => {
  if (rule.detector) {
    const builtin = resolveBuiltin(rule.detector);
    if (!builtin) return [];
    return builtin(ctx, rule.detectorArgs ?? {});
  }

  const conditions = rule.conditions ?? [];
  if (conditions.length === 0) return [];

  // AND: every positive condition must match.
  const matches: ConditionMatch[] = [];
  for (const condition of conditions) {
    const result = evaluateCondition(condition, ctx);
    if (!result) return [];
    matches.push(result);
  }

  // AND-NOT: any negative condition that matches suppresses the rule.
  const negatives = rule.negativeConditions ?? [];
  for (const condition of negatives) {
    if (evaluateCondition(condition, ctx)) return [];
  }

  // Build one violation per positive match, applying the message
  // template when set. Most rules produce one finding per tool call,
  // but multi-condition rules surface each match for transparency.
  const violations: Violation[] = matches.map((m) => {
    const baseMessage = rule.message ?? defaultMessage(rule, m);
    return applyMessageTemplate(
      rule,
      { ...m.violation, message: baseMessage },
      m.captures,
    );
  });

  return violations;
};

/** Fallback message when a rule has no `message` template. */
const defaultMessage = (rule: RuleEntry, _m: ConditionMatch) =>
  `${rule.id}: violation detected — see the paired rule for details.`;

/**
 * Convenience helper for adapters: run rules and format the findings
 * into a single nudge string in one call. Returns null when there are
 * no findings (so the adapter can guard with `if (!nudge) skip`).
 */
export const runAndFormat = async (
  rules: ReadonlyArray<RuleEntry>,
  ctx: DetectorContext,
) => {
  const findings = await runRules(rules, ctx);
  return formatFindings(findings);
};

/**
 * Compile a TOML-loaded condition: pre-validate the regex pattern at
 * load time so the matcher stays synchronous. Returns the compiled
 * form OR a string error message — loader collects errors as
 * `LoadError` rather than throwing.
 */
export const compileCondition = async (condition: CompiledCondition) => {
  if (condition.operator !== "regex_match") {
    return { ok: true as const, condition };
  }
  const compiled = await Promise.resolve()
    .then(() => ({ regex: new RegExp(condition.pattern), error: null }))
    .catch((err) => ({
      regex: null,
      error: err instanceof Error ? err.message : String(err),
    }));
  if (compiled.regex === null) {
    return {
      ok: false as const,
      error: compiled.error ?? "regex compile failed",
    };
  }
  return {
    ok: true as const,
    condition: { ...condition, regex: compiled.regex },
  };
};
