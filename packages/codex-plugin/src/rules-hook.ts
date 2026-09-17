/**
 * Rules engine PreToolUse hook adapter (ported from cc-plugin).
 *
 * Codex invokes it with the hook payload on stdin; we normalise the
 * Codex tool call into CC-equivalent calls (apply_patch fans out to one
 * Edit/Write per touched file — tool-map.ts), run the rule engine
 * against `.claude/**\/*.enforce.toml` files in the session's project
 * root for each, and answer in the CC-style hook protocol: a blocking
 * finding denies the call with the findings as the reason, a nudge
 * finding attaches advice. Rules block unless they set
 * `severity = "nudge"` — the same on every host.
 *
 * Codex's shell tool is literally named "Bash" with tool_input.command,
 * so command-based detectors work with zero translation.
 */

import {
  type DetectorContext,
  loadRules,
  mergeVerdicts,
  preToolUseOutput,
  type RuleVerdict,
  runAndPartition,
} from "@mimir/plugin-core/rules";
import { errMessage } from "@mimir/plugin-core/util";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";
import { normalizeToolCalls } from "./tool-map";

const log = createLogger("rules-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

/**
 * Entry point invoked from cli.ts when argv[2] === "rules".
 *
 * Exit code is always 0 even on internal errors: a thrown exception
 * inside the hook would prevent the user's tool call from running, and
 * a broken rule engine is a much worse failure mode than a missed
 * violation.
 */
export const runRulesHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();
  if (!input.tool_name) return 0;

  const projectPath = input.cwd ?? process.cwd();
  const calls = normalizeToolCalls(input.tool_name, input.tool_input);
  if (calls.length === 0) return 0;

  const loaded = await loadRules(projectPath).catch((err) => {
    log.error("loadRules failed", { error: errMessage(err) });
    return null;
  });
  if (!loaded || loaded.rules.length === 0) return 0;

  if (loaded.errors.length > 0) {
    log.warn("some rules failed to load", {
      count: loaded.errors.length,
      first: loaded.errors[0],
    });
  }

  // apply_patch can touch several files — collect every verdict so a
  // multi-file patch reports each violating file, not just the first.
  const verdicts: RuleVerdict[] = [];
  for (const call of calls) {
    const ctx: DetectorContext = {
      toolName: call.toolName,
      toolInput: call.toolInput,
      projectPath,
    };
    const verdict = await runAndPartition(loaded.rules, ctx).catch((err) => {
      log.error("runAndPartition failed", { error: errMessage(err) });
      return null;
    });
    if (verdict) verdicts.push(verdict);
  }
  const merged = mergeVerdicts(verdicts);
  const output = preToolUseOutput(merged);
  if (!output) return 0;

  log.info(merged.block ? "rule violation blocked" : "rule nudge surfaced", {
    toolName: input.tool_name,
    normalizedCalls: calls.length,
    ruleCount: loaded.rules.length,
  });
  process.stdout.write(JSON.stringify(output));
  return 0;
};
