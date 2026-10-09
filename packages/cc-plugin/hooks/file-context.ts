/**
 * File context on Read — the `tool.call` hook on the built-in Read tool.
 *
 * Runs `mimir-cc file-context` (cartographer symbols, imports and
 * dependents from the local index, related memories from the replica)
 * alongside the read itself, and attaches its block to the result as
 * `context`: what the model reads after the file, which the developer
 * never sees. The binary dedupes per session by content hash, so a file
 * read twice unchanged is framed once.
 *
 * The two run at once — the read never waits on the index. Fails open
 * with a status line.
 */

import type { ProcessRunResult, Register } from "claude-code";
import { mimirCcArgv, mimirCcInit } from "./binary";
import { parsePreToolUseOutput, toolPayload } from "./payload";

const FILE_CONTEXT_TIMEOUT_MS = 15_000;

/** The leg's outcome: context and status to show, from the run or its failure. */
export const fileContextOutcome = (
  settled: PromiseSettledResult<ProcessRunResult>,
) => {
  if (settled.status === "rejected")
    return { status: "mimir: file context failed" };
  const ran = settled.value;
  if (ran.exitCode !== 0)
    return { status: `mimir: file context failed (exit ${ran.exitCode})` };
  const out = parsePreToolUseOutput(ran.stdout);
  return {
    status: out.systemMessage,
    context: out.hookSpecificOutput?.additionalContext,
  };
};

export const registerFileContext: Register = (on) => {
  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const [home, sessionId, cwd] = await Promise.all([
      $.env.get("HOME"),
      $.session.id(),
      $.session.cwd(),
    ]);
    const payload = toolPayload(e, { sessionId, cwd, agentId: e.agentId });
    const [ran, [leg]] = await Promise.all([
      next(e),
      Promise.allSettled([
        $.process.run(
          mimirCcArgv(home ?? "", "file-context"),
          mimirCcInit(payload, FILE_CONTEXT_TIMEOUT_MS),
        ),
      ]),
    ]);
    const outcome = fileContextOutcome(leg);
    if (outcome.status !== undefined) $.ui.status(outcome.status);
    return outcome.context === undefined || ran.deny !== undefined
      ? ran
      : { ...ran, context: [...(ran.context ?? []), outcome.context] };
  }).catch(($, e, next) => {
    $.ui.status("mimir: file context failed");
    return next(e);
  });
};
