/**
 * Cartographer reindex after a file write — the `tool.call` hook on Edit
 * and Write.
 *
 * Once the tool has run, `mimir-cc reindex` gets the PostToolUse payload:
 * it forks a detached worker that parses the file into the local index
 * and exits at once, so the turn waits on the fork alone. The binary
 * skips a subagent's edit (`agent_id`): a worker writes inside an
 * ephemeral worktree, and the session-start reindex picks up what the
 * coordinator merges.
 *
 * Nothing here can change the tool's result; a failure costs the index
 * one file and shows as a status line.
 */

import type { Register } from "claude-code";
import { mimirCcArgv, mimirCcInit } from "./binary";
import { toolPayload } from "./payload";

const REINDEX_TIMEOUT_MS = 10_000;
export const WRITE_TOOLS = ["Edit", "Write"] as const;

export const registerReindex: Register = (on) => {
  on("tool.call", { tool: [...WRITE_TOOLS] }, async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny !== undefined || ran.isError === true) return ran;
    const [home, sessionId, cwd] = await Promise.all([
      $.env.get("HOME"),
      $.session.id(),
      $.session.cwd(),
    ]);
    const payload = toolPayload(
      e,
      { sessionId, cwd, agentId: e.agentId },
      "PostToolUse",
    );
    const fork = await $.process.run(
      mimirCcArgv(home ?? "", "reindex"),
      mimirCcInit(payload, REINDEX_TIMEOUT_MS),
    );
    if (fork.exitCode !== 0)
      $.ui.status(`mimir: reindex failed (exit ${fork.exitCode})`);
    return ran;
  }).catch(($, e, next) => {
    $.ui.status("mimir: reindex failed");
    return next(e);
  });
};
