/**
 * Which directory a subagent's tool call works in.
 *
 * Claude Code runs a worktree-isolated subagent in `<top level of the
 * session's work tree>/.claude/worktrees/agent-<agent id>`, but the hook
 * payload's `cwd` is the session's directory. `mimir-cc rules`, `guard`
 * and `verify` resolve the worktree here so each judges the agent's own
 * tree. A `cwd` already inside that worktree is kept as given.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type CommandRunner, runCommand } from "@mimir/plugin-core/verify";
import { workerByName } from "@mimir/plugin-core/workers";
import { createLogger } from "./logger";
import { WORKTREES_DIRS } from "./worktree-types";

const log = createLogger("agent-worktree");

const WORKTREES_DIR = join(...WORKTREES_DIRS);

const worktreeName = (agentId: string) => `agent-${agentId}`;

/** The top level of `cwd`'s git work tree; `cwd` itself outside one. */
const topLevelOf = async (cwd: string, run: CommandRunner) => {
  const result = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  const top = result.stdout.trim();
  if (result.code === 0 && !result.timedOut && top) return top;
  log.debug("not inside a git work tree — looking beside cwd", {
    cwd,
    stderr: result.stderr.trim(),
  });
  return cwd;
};

const isAgentWorktree = (top: string, agentId: string) =>
  basename(top) === worktreeName(agentId) &&
  dirname(top).endsWith(WORKTREES_DIR);

/**
 * `{ cwd, missing }`: the directory to work in, and — when the agent has
 * no worktree — the path that was looked for (null otherwise).
 */
export const resolveAgentCwd = async (
  cwd: string,
  agentId: string | undefined,
  run: CommandRunner = runCommand,
) => {
  if (!agentId || !existsSync(cwd)) return { cwd, missing: null };
  const top = await topLevelOf(cwd, run);
  if (isAgentWorktree(top, agentId)) return { cwd, missing: null };
  const worktree = join(top, WORKTREES_DIR, worktreeName(agentId));
  return existsSync(worktree)
    ? { cwd: worktree, missing: null }
    : { cwd, missing: worktree };
};

/**
 * A hook payload with its `cwd` moved into the agent's worktree.
 *
 * `missing` is the worktree path looked for when one of Mimir's workers
 * has none — each such call logs a warning. Any other subagent (Explore,
 * Plan, …) runs in the session's directory, so no worktree is expected:
 * it keeps the payload's cwd silently and `missing` stays null.
 */
export const withAgentCwd = async <
  T extends {
    readonly cwd?: string;
    readonly agent_id?: string;
    readonly agent_type?: string;
  },
>(
  input: T,
  run: CommandRunner = runCommand,
) => {
  if (!input.agent_id) return { input, missing: null };
  const resolved = await resolveAgentCwd(
    input.cwd ?? process.cwd(),
    input.agent_id,
    run,
  );
  const isWorker = workerByName(input.agent_type ?? "") !== null;
  const missing = isWorker ? resolved.missing : null;
  if (missing)
    log.warn("no worktree for the worker — using the payload's cwd", {
      agentId: input.agent_id,
      agentType: input.agent_type,
      lookedFor: missing,
      cwd: resolved.cwd,
    });
  return { input: { ...input, cwd: resolved.cwd }, missing };
};
