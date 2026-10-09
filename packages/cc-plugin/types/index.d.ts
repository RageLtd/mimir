/**
 * The plugin's `$.state` contract — what `claude plugin validate` holds
 * the hooks module's state keys to.
 */

export type MimirTurn = number;

declare module "claude-code" {
  interface PluginState {
    /** Developer turns this session, counted on `prompt.submit`. */
    "mimir-cc": { turn: MimirTurn };
  }
}
