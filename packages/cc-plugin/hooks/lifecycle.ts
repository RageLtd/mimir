/**
 * The session lifecycle — session start, turn end and compaction — as
 * `classic.*` hooks, each handing its event's payload to the subcommand
 * that was written against it.
 *
 * The classic events are the right bridge here: `classic.SessionStart`
 * carries `source` (startup, resume, clear, compact), which the engine's
 * own `session.start` does not and the reindex keys on; `classic.Stop`
 * and `classic.PreCompact` carry `transcript_path`, which the delta
 * reader walks. Every payload crosses verbatim, so the binary's contract
 * is the command hook's still.
 *
 * - `classic.SessionStart` → `mimir-cc session-start`: key reconcile and
 *   blind org sync (bounded), then a detached full reindex on startup or
 *   resume.
 * - `classic.Stop` → `mimir-cc persist`: the turn's transcript delta,
 *   distilled into the local replica.
 * - `classic.PreCompact` → `mimir-cc precompact`: the undistilled tail,
 *   summarised before the engine discards it.
 *
 * None of them can change what the engine does; a failure shows as a
 * status line and the event passes on.
 */

import type { Register } from "claude-code";
import { mimirCcArgv, mimirCcInit } from "./binary";

/** The binary bounds its reconcile at 15 s and detaches the reindex. */
const SESSION_START_TIMEOUT_MS = 20_000;
const PERSIST_TIMEOUT_MS = 10_000;
const PRECOMPACT_TIMEOUT_MS = 15_000;

export const registerLifecycle: Register = (on) => {
  on("classic.SessionStart", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const ran = await $.process.run(
      mimirCcArgv(home, "session-start"),
      mimirCcInit(e, SESSION_START_TIMEOUT_MS),
    );
    if (ran.exitCode !== 0)
      $.ui.status(`mimir: session start failed (exit ${ran.exitCode})`);
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status("mimir: session start failed");
    return next(e);
  });

  on("classic.Stop", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const ran = await $.process.run(
      mimirCcArgv(home, "persist"),
      mimirCcInit(e, PERSIST_TIMEOUT_MS),
    );
    if (ran.exitCode !== 0)
      $.ui.status(`mimir: persist failed (exit ${ran.exitCode})`);
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status("mimir: persist failed");
    return next(e);
  });

  on("classic.PreCompact", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const ran = await $.process.run(
      mimirCcArgv(home, "precompact"),
      mimirCcInit(e, PRECOMPACT_TIMEOUT_MS),
    );
    if (ran.exitCode !== 0)
      $.ui.status(`mimir: precompact failed (exit ${ran.exitCode})`);
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status("mimir: precompact failed");
    return next(e);
  });
};
