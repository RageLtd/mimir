/**
 * `/hygiene [model] [--live]` — memory hygiene relocated client-side
 * (MIM-86): the sweep runs over the local replica on the developer's
 * extraction model. The server's /v1/hygiene/sweep route no longer exists.
 *
 * ACP gains its local replica (and with it a working /hygiene) when MIM-89
 * inverts the agent to run fully local. Until then this command explains
 * itself instead of dialing a dead route.
 */

import type { CommandDeps } from "./commands";
import { emitAgentText } from "./lifecycle-helpers";

const END_TURN = { stopReason: "end_turn" as const };

export const runHygiene = async (
  deps: CommandDeps,
  sessionId: string,
  _opts: { modelId: string | undefined; live: boolean },
) => {
  await emitAgentText(
    deps.conn,
    sessionId,
    "Memory hygiene moved client-side (MIM-86) — the sweep runs over the " +
      "local replica via the Claude Code plugin's `hygiene` command. ACP " +
      "picks it up when the local agent inversion lands (MIM-89).",
  );
  return END_TURN;
};
