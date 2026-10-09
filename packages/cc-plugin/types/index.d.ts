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

declare module "claude-code" {
  interface PluginState {
    "mimir-cc": {
      /** Developer turns this session, counted on `prompt.submit`. */
      turn: MimirTurn;
      /** Subagents by id, for the gates that run inside them. */
      agents: StateFamily<MimirAgent>;
    };
  }
}
