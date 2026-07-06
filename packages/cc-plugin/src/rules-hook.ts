/**
 * Rules engine PreToolUse hook adapter.
 *
 * Wired into ~/.mimir/settings.json as a PreToolUse hook command. CC
 * invokes it with the hook payload on stdin; we read it, run the rule
 * engine against `.claude/**\/*.enforce.toml` files in the session's
 * project root, and emit `additionalContext` (only when there's a
 * finding) so the model sees the nudge alongside the tool call.
 *
 * Equivalent to packages/acp/src/backends/claude-code/rule-hooks.ts —
 * but instead of returning to the SDK in-process, we serialise to the
 * CC hook protocol shape:
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }
 *
 * Defence in depth: MIMIR_ACTIVE gate matches the voice-anchor hook,
 * so a nested `claude` subprocess inside a mimir session can't
 * unexpectedly trigger rule enforcement against the parent's rules.
 */

import {
  type DetectorContext,
  loadRules,
  runAndFormat,
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

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  return buf.toString("utf8");
};

const safeParseHookInput = (raw: string): HookInput => {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
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
const buildContext = (input: HookInput): DetectorContext => ({
  toolName: input.tool_name ?? "",
  toolInput:
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {},
  projectPath: input.cwd ?? process.cwd(),
});

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
 * violation. Errors get a stderr line (CC surfaces those in --debug)
 * and we return cleanly.
 */
export const runRulesHook = async (): Promise<number> => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = safeParseHookInput(raw);
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

  const nudge = await runAndFormat(loaded.rules, ctx).catch((err) => {
    log.error("runAndFormat failed", { error: errMessage(err) });
    return null;
  });
  if (!nudge) return 0;

  log.info("rule violation surfaced", {
    toolName: ctx.toolName,
    ruleCount: loaded.rules.length,
  });
  emitAdditionalContext(nudge);
  return 0;
};
