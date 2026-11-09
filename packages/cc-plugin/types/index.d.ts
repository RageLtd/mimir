/**
 * The plugin's `$.state` contract — what `claude plugin validate` holds
 * the hooks module's state keys to.
 */

export type MimirTurn = number;

/**
 * What the module knows of one subagent, recorded on `classic.SubagentStart`
 * (the one event that names a worker's cwd — its worktree — beside its
 * id) and read by the tool.call hooks, whose `e` carries `agentId` alone.
 */
export type MimirAgent = {
  readonly cwd: string;
  readonly type: string;
};

/**
 * Where the last distillation stopped: how many messages of the main
 * conversation it covered and the mark (role and text) of the last one,
 * so the point is found again after the window slides or compacts.
 */
export type MimirAnchor = {
  readonly count: number;
  readonly mark: string;
};

/**
 * A distillation scheduled off the turn and not yet settled: the anchor it
 * will move to, and when it was scheduled (`$.clock.now()`), so one left
 * behind by a session that ended mid-run goes stale instead of blocking.
 */
export type MimirPending = {
  readonly anchor: MimirAnchor;
  readonly at: number;
};

declare module "claude-code" {
  interface PluginState {
    "mimir-cc": {
      /** Developer turns this session, counted on `prompt.submit`. */
      turn: MimirTurn;
      /** Subagents by id, for the gates that run inside them. */
      agents: StateFamily<MimirAgent>;
      /** The main conversation's distilled prefix, advanced by persist. */
      distilled: MimirAnchor;
      /** The distillation in flight, null once it settles. */
      pending: MimirPending | null;
    };
  }
}
