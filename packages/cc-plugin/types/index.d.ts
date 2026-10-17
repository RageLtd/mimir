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

declare module "claude-code" {
  interface PluginState {
    "mimir-cc": {
      /** Developer turns this session, counted on `prompt.submit`. */
      turn: MimirTurn;
      /** Subagents by id, for the gates that run inside them. */
      agents: StateFamily<MimirAgent>;
      /** The main conversation's distilled prefix, advanced by persist. */
      distilled: MimirAnchor;
    };
  }
}
