/**
 * `session.end` → `mimir-cc session-end`: the ending session's whole
 * conversation, summarised so the next session picks up its narrative.
 *
 * It hands off and returns because the engine's `session.end` chain —
 * every hook, its `$` waits and core — shares one short wall-clock bound
 * (1.5 s by default), at which a `$` call in flight is aborted. Only a
 * process the command let go of outlives it, so the binary detaches the
 * summarising worker and returns at once; no model call runs here, and
 * the run's own bound sits well inside the chain's.
 *
 * Every reason runs it, a `/clear` included — that conversation ends too.
 * An empty conversation, or one precompact already summarised as it
 * stands (`summarised` in `$.state`), runs nothing. A failure shows as a
 * status line and the event passes on.
 *
 * After a `/clear` or a resume the process goes on under another session,
 * so the hook first flags the next prompt as a reset (`reanchor`) and,
 * for a resume, as one that starts `mimir-cc session-start` again
 * (`resumed`; submit.ts).
 */

import type { Register, StateRef } from "claude-code";
import { mimirCcArgv, mimirCcInit } from "./binary";
import { sameAnchor } from "./lifecycle";
import { anchorOf, slim } from "./messages";

/** The binary only decides and detaches its worker. */
const SESSION_END_TIMEOUT_MS = 1_000;

/**
 * Precompact's record of the window it last summarised (lifecycle.ts). The
 * engine lists the state a module touches from literals in the calling
 * file, so the reference is spelled here rather than imported.
 */
const SUMMARISED = {
  plugin: "mimir-cc",
  key: "summarised",
} satisfies StateRef<"mimir-cc", "summarised">;
const REANCHOR = {
  plugin: "mimir-cc",
  key: "reanchor",
} satisfies StateRef<"mimir-cc", "reanchor">;
const RESUMED = {
  plugin: "mimir-cc",
  key: "resumed",
} satisfies StateRef<"mimir-cc", "resumed">;

export const registerSessionEnd: Register = (on) => {
  on("session.end", async ($, e, next) => {
    // Written before the run, inside the chain's short bound.
    if (e.reason === "clear" || e.reason === "resume")
      await $.state.set(REANCHOR, true);
    if (e.reason === "resume") await $.state.set(RESUMED, true);
    const [messages, summarised] = await Promise.all([
      $.session.messages({ as: "api" }),
      $.state.get(SUMMARISED),
    ]);
    if (messages.length === 0) return next(e);
    if (sameAnchor(summarised.value, anchorOf(messages))) return next(e);
    const [home, cwd] = await Promise.all([$.env.get("HOME"), $.session.cwd()]);
    const ran = await $.process.run(
      mimirCcArgv(home ?? "", "session-end"),
      mimirCcInit(
        {
          session_id: e.sessionId,
          cwd,
          reason: e.reason,
          window: messages.map(slim),
        },
        SESSION_END_TIMEOUT_MS,
      ),
    );
    if (ran.exitCode !== 0)
      $.ui.status(`mimir: session end failed (exit ${ran.exitCode})`);
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status("mimir: session end failed");
    return next(e);
  });
};
