/**
 * Worker worktree bootstrap — `git worktree add` gives a worker a checkout
 * with no `node_modules`, and Claude Code has no post-create hook to fix
 * that (WorktreeCreate fires before the tree exists). The role guard runs
 * on the worker's first tool call inside the worktree, so it installs
 * there once: a warm Bun cache makes this a couple of seconds, and the
 * worker never burns turns discovering the problem.
 *
 * First it lays the engine's plugin type declarations, which git never
 * carries, from the coordinator's tree (`worktree-types.ts`); then it
 * installs. Only Bun projects install for now (a `bun.lock` at the
 * worktree root). The markers live under ~/.mimir/agents, not in the
 * worktree, so neither step is retried on every call and no marker shows
 * up in the worker's diff.
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { mimirHome } from "@mimir/plugin-core/util";
import { type CommandRunner, runCommand } from "@mimir/plugin-core/verify";
import { layEngineTypes, WORKTREES_SEGMENT } from "./worktree-types";

const LOCKFILE = "bun.lock";
const MODULES = "node_modules";
const INSTALL: readonly string[] = ["bun", "install", "--frozen-lockfile"];
/** Generous: a cold cache on a big workspace. */
const INSTALL_TIMEOUT_MS = 120_000;

const markerPath = (worktree: string) =>
  join(
    mimirHome(),
    "agents",
    `bootstrap-${worktree.split(sep).filter(Boolean).at(-1) ?? "worktree"}.json`,
  );

export type BootstrapOutcome =
  | "not-a-worktree"
  | "ready"
  | "installed"
  | "failed";

/** True for a path inside a Claude Code agent worktree. */
export const isAgentWorktree = (cwd: string) => cwd.includes(WORKTREES_SEGMENT);

/**
 * Lay the engine types, then install once. `ready` when nothing was
 * needed (modules present, no lockfile, or already attempted);
 * `installed` / `failed` after a run.
 */
export const bootstrapWorktree = async (
  cwd: string,
  run: CommandRunner = runCommand,
) => {
  if (!isAgentWorktree(cwd)) return "not-a-worktree" satisfies BootstrapOutcome;
  await layEngineTypes(cwd);
  if (!existsSync(join(cwd, LOCKFILE)))
    return "ready" satisfies BootstrapOutcome;
  if (existsSync(join(cwd, MODULES))) return "ready" satisfies BootstrapOutcome;
  const marker = markerPath(cwd);
  if (existsSync(marker)) return "ready" satisfies BootstrapOutcome;
  await Bun.write(
    marker,
    `${JSON.stringify({ cwd, at: new Date().toISOString() })}\n`,
  );
  const result = await run([...INSTALL], cwd, INSTALL_TIMEOUT_MS);
  const ok = result.code === 0 && !result.timedOut;
  return ok
    ? ("installed" satisfies BootstrapOutcome)
    : ("failed" satisfies BootstrapOutcome);
};
