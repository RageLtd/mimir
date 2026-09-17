/**
 * Rules engine PreToolUse hook adapter.
 *
 * Wired into ~/.mimir/settings.json as a PreToolUse hook command. CC
 * invokes it with the hook payload on stdin; we read it, run the rule
 * engine against `.claude/**\/*.enforce.toml` files in the session's
 * project root, and answer in the CC hook protocol:
 *
 *   blocking finding → permissionDecision: "deny" with the findings as
 *                      the reason (the call does not run)
 *   nudge finding    → additionalContext (the call runs, advice attached)
 *
 * Rules block unless they opt down with `severity = "nudge"` — the same
 * behaviour on every host, main session or subagent alike.
 *
 * Defence in depth: MIMIR_ACTIVE gate matches the voice-anchor hook,
 * so a nested `claude` subprocess inside a mimir session can't
 * unexpectedly trigger rule enforcement against the parent's rules.
 */

import {
  type DetectorContext,
  loadRules,
  preToolUseOutput,
  runAndPartition,
} from "@mimir/plugin-core/rules";
import { errMessage } from "@mimir/plugin-core/util";
import { createLogger } from "./logger";

const log = createLogger("rules-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const safeParseHookInput = (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  // Serialisation boundary: the hook payload arrives as untyped JSON.
  return Promise.resolve()
    .then(() => JSON.parse(raw) as HookInput)
    .catch(() => ({}) as HookInput);
};

/**
 * Build the engine's `DetectorContext` from the CC hook payload. The
 * hook delivers `tool_input` as `unknown` (shape varies per tool); we
 * narrow defensively and pass an empty object on shape mismatch — the
 * engine then no-ops gracefully because none of its field extractors
 * find the values they need.
 *
 * `cwd` from the hook event is the session's project root, matching
 * the engine's expectation for builtins like `file-length` that read
 * the on-disk file when relative paths are passed.
 */
export const buildContext = (input: HookInput) =>
  ({
    toolName: input.tool_name ?? "",
    toolInput:
      input.tool_input && typeof input.tool_input === "object"
        ? (input.tool_input as Record<string, unknown>)
        : {},
    projectPath: input.cwd ?? process.cwd(),
  }) satisfies DetectorContext;

/**
 * Entry point invoked from cli.ts when argv[2] === "rules".
 *
 * Exit code is always 0 even on internal errors: a thrown exception
 * inside the hook would prevent the user's tool call from running, and
 * a broken rule engine is a much worse failure mode than a missed
 * violation. Errors get a stderr line (CC surfaces those in --debug)
 * and we return cleanly.
 */
export const runRulesHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);
  const ctx = buildContext(input);

  if (!ctx.toolName) return 0;

  const loaded = await loadRules(ctx.projectPath).catch((err) => {
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

  const verdict = await runAndPartition(loaded.rules, ctx).catch((err) => {
    log.error("runAndPartition failed", { error: errMessage(err) });
    return null;
  });
  if (!verdict) return 0;

  const output = preToolUseOutput(verdict);
  if (!output) return 0;

  log.info(verdict.block ? "rule violation blocked" : "rule nudge surfaced", {
    toolName: ctx.toolName,
    ruleCount: loaded.rules.length,
  });
  process.stdout.write(JSON.stringify(output));
  return 0;
};
