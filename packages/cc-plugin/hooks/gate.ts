/**
 * The gates on tool calls and hand-backs — rules, the role guard and the
 * verify gate — as `tool.call` hooks.
 *
 * - One unmatched `tool.call` hook (the engine takes one per event from
 *   a module) runs `mimir-cc rules` and `mimir-cc guard` at once: a deny
 *   from either refuses the call, rules' reason first; a nudge rides the
 *   result as `context`, what the model reads after the tool's output.
 * - `{ tool: "SubagentHandback" }` is the verify gate: inside a worker,
 *   the hand-back's `message` is its final text. Deny sends the worker
 *   back to work; pass rewrites the message with the report appended
 *   (`updatedInput`), so the coordinator reads numbers.
 *
 * A `tool.call` carries the loop's `agentId` and nothing else about it:
 * the gates send the session's cwd beside the id and the type
 * `$.agent.list()` gives it, and the binary resolves the worker's
 * worktree from the two.
 *
 * Every gate fails open with a status line, as the command hooks did:
 * a crashing gate must never wedge a session or a worker.
 */

import type {
  EngineInterface,
  ProcessRunResult,
  Register,
  ToolCallInput,
} from "claude-code";
import { type MimirCcCall, mimirCcCall } from "./binary";
import { type Loop, parsePreToolUseOutput, toolPayload } from "./payload";

const RULES_TIMEOUT_MS = 15_000;
/** The guard installs a worker worktree's dependencies on its first call. */
const GUARD_TIMEOUT_MS = 150_000;
/** The verify gate runs a project's toolchain; the engine's ceiling. */
const VERIFY_TIMEOUT_MS = 600_000;

/**
 * The hand-back tool is the engine's own, undeclared in the tools table,
 * so the matcher names it by pattern rather than by literal.
 */
export const HANDBACK_TOOL = /^SubagentHandback$/;
/**
 * The agent type the guard sees for a subagent `$.agent.list()` does not
 * list: not a known worker, so the guard stays silent rather than mistaking
 * it for the coordinator (which is what no `agent_type` means).
 */
export const UNKNOWN_AGENT_TYPE = "unknown";

/** One gate leg's verdict from the binary's stdout, or why it has none. */
export const legVerdict = (
  name: string,
  settled: PromiseSettledResult<ProcessRunResult>,
) => {
  if (settled.status === "rejected") return { status: `mimir: ${name} failed` };
  const ran = settled.value;
  if (ran.exitCode !== 0)
    return { status: `mimir: ${name} failed (exit ${ran.exitCode})` };
  const out = parsePreToolUseOutput(ran.stdout).hookSpecificOutput;
  return {
    deny:
      out?.permissionDecision === "deny"
        ? (out.permissionDecisionReason ?? `${name}: denied`)
        : undefined,
    context: out?.additionalContext,
  };
};

/** The hand-back message after the gate: a rewrite, or null to keep it. */
export const handbackRewrite = (stdout: string) => {
  const out = parsePreToolUseOutput(stdout).hookSpecificOutput;
  if (out?.permissionDecision === "deny")
    return {
      deny: out.permissionDecisionReason ?? "verify gate: blocked",
      message: undefined,
    };
  const message = out?.updatedInput?.message;
  return typeof message === "string" ? { deny: undefined, message } : null;
};

/** Writes a call's payload file, then runs the binary on it (binary.ts). */
const runBinary = ($: EngineInterface, call: MimirCcCall) =>
  $.fs
    .write(call.path, call.text)
    .then(() => $.process.run(call.argv, call.init));

const loopFor = async ($: EngineInterface, e: ToolCallInput) => {
  const [sessionId, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
  if (e.agentId === undefined) return { sessionId, cwd } satisfies Loop;
  const listed = (await $.agent.list()).find((agent) => agent.id === e.agentId);
  return {
    sessionId,
    cwd,
    agentId: e.agentId,
    agentType: listed?.type ?? UNKNOWN_AGENT_TYPE,
  } satisfies Loop;
};

export const registerGate: Register = (on) => {
  on("tool.call", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const payload = toolPayload(e, await loopFor($, e));
    const [rules, guard] = await Promise.allSettled([
      runBinary($, mimirCcCall(home, "rules", payload, RULES_TIMEOUT_MS)),
      runBinary($, mimirCcCall(home, "guard", payload, GUARD_TIMEOUT_MS)),
    ]);
    const verdicts = [
      legVerdict("rules", rules),
      legVerdict("role guard", guard),
    ];
    for (const verdict of verdicts) {
      if (verdict.status !== undefined) $.ui.status(verdict.status);
    }
    const denied = verdicts.find((verdict) => verdict.deny !== undefined);
    if (denied?.deny !== undefined) return { deny: denied.deny };

    const context = verdicts.flatMap((verdict) =>
      verdict.context === undefined ? [] : [verdict.context],
    );
    const ran = await next(e);
    return context.length === 0 || ran.deny !== undefined
      ? ran
      : { ...ran, context: [...(ran.context ?? []), ...context] };
  }).catch(($, e, next) => {
    $.ui.status("mimir: tool gate failed");
    return next(e);
  });

  on("tool.call", { tool: HANDBACK_TOOL }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e);
    const home = (await $.env.get("HOME")) ?? "";
    const ran = await runBinary(
      $,
      mimirCcCall(
        home,
        "verify",
        toolPayload(e, await loopFor($, e)),
        VERIFY_TIMEOUT_MS,
      ),
    );
    if (ran.exitCode !== 0) {
      $.ui.status(`mimir: verify gate failed (exit ${ran.exitCode})`);
      return next(e);
    }
    const rewrite = handbackRewrite(ran.stdout);
    if (rewrite === null) return next(e);
    if (rewrite.deny !== undefined) return { deny: rewrite.deny };
    const rewritten = { ...e, message: rewrite.message };
    return next(rewritten);
  }).catch(($, e, next) => {
    $.ui.status("mimir: verify gate failed");
    return next(e);
  });
};
