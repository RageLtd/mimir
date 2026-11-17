/**
 * `mimir-cc boot-context` — the boot context block, run by the hooks
 * module's `prompt.submit` hook on the session's first prompt and on the
 * first prompt after a compaction or `/clear` replaced the window.
 *
 * Reads `{ cwd, session_id }` from stdin and prints the `<boot_context>`
 * block (user profile + active project) from the local stores. No
 * session-context section: the same hook retrieves per turn for that,
 * from turn one. The
 * assembly is shared (@mimir/plugin-core/brain/boot-context); this binds
 * cc-plugin's logger so boot lines keep landing in mimir-cc.log.
 */

import { assembleBootContext } from "@mimir/plugin-core/brain/boot-context";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage } from "@mimir/plugin-core/util";
import { readPayload } from "./hook-payload";
import { createLogger } from "./logger";

const log = createLogger("boot-context");

type Input = { readonly cwd?: string; readonly session_id?: string };

export const runBootContextCommand = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readPayload();
  const [parseErr, input] = await attempt(async () => JSON.parse(raw) as Input);
  const projectPath = (parseErr ? undefined : input.cwd) ?? process.cwd();
  // Ties the block to a session: a host can fire SessionStart more than once.
  log.info("boot context requested", {
    sessionId: parseErr ? undefined : input.session_id,
    projectPath,
  });

  const [err, block] = await attempt(() =>
    assembleBootContext({ projectPath, log }),
  );
  if (err) {
    log.error("assembleBootContext threw", { error: errMessage(err) });
    return 1;
  }
  if (block) process.stdout.write(block);
  return 0;
};
