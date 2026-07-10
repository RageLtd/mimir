/**
 * Rules engine PreToolUse hook adapter (ported from cc-plugin).
 *
 * Codex invokes it with the hook payload on stdin; we normalise the
 * Codex tool call into CC-equivalent calls (apply_patch fans out to one
 * Edit/Write per touched file — tool-map.ts), run the rule engine
 * against `.claude/**\/*.enforce.toml` files in the session's project
 * root for each, and emit `additionalContext` (only when there's a
 * finding) so the model sees the nudge alongside the tool call.
 *
 * Codex's shell tool is literally named "Bash" with tool_input.command,
 * so command-based detectors work with zero translation.
 */

import {
  type DetectorContext,
  loadRules,
  runAndFormat,
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

const emitAdditionalContext = (text: string) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: text,
      },
    }),
  );
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

  // apply_patch can touch several files — collect every nudge so a
  // multi-file patch reports each violating file, not just the first.
  const nudges: string[] = [];
  for (const call of calls) {
    const ctx: DetectorContext = {
      toolName: call.toolName,
      toolInput: call.toolInput,
      projectPath,
    };
    const nudge = await runAndFormat(loaded.rules, ctx).catch((err) => {
      log.error("runAndFormat failed", { error: errMessage(err) });
      return null;
    });
    if (nudge) nudges.push(nudge);
  }
  if (nudges.length === 0) return 0;

  log.info("rule violation surfaced", {
    toolName: input.tool_name,
    normalizedCalls: calls.length,
    findings: nudges.length,
    ruleCount: loaded.rules.length,
  });
  emitAdditionalContext(nudges.join("\n\n"));
  return 0;
};
