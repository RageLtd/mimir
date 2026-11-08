/**
 * The session lifecycle — session start, turn end and compaction — each
 * handing the subcommand written against it what it needs.
 *
 * - `classic.SessionStart` → `mimir-cc session-start`: on startup or
 *   resume, detaches a worker that reconciles keys, syncs the org replica
 *   and reindexes the project, then returns at once so the first prompt
 *   is never behind it. The classic event is the bridge because it
 *   carries `source`, which the engine's own `session.start` does not.
 * - `turn.complete` (main loop) → `mimir-cc persist`: the messages since
 *   the last distillation, read from `$.session.messages({ as: "api" })`
 *   and distilled into the local replica.
 * - `session.compact` (main loop, not `precompute`) → `mimir-cc precompact`:
 *   the undistilled tail, summarised before the engine discards it.
 *
 * Where the last distillation stopped lives in `$.state` as an anchor
 * (messages.ts). The binary answers `{ advance }`: true once the delta is
 * settled — distilled, or skipped on purpose — false when extraction
 * failed and the next turn should carry the same messages again. After a
 * compaction the anchor is the compacted conversation whatever happened,
 * so the engine's own summary is never distilled as if it were a turn.
 *
 * None of these can change what the engine does; a failure shows as a
 * status line and the event passes on.
 */

import type { EngineInterface, ProcessRunResult, Register } from "claude-code";
import type { MimirAnchor } from "../types";
import { mimirCcArgv, mimirCcInit, parseHookOutput } from "./binary";
import { anchorOf, deltaSince, NO_ANCHOR, slim } from "./messages";

/** The binary only parses the payload and detaches its worker. */
const SESSION_START_TIMEOUT_MS = 5_000;
const PERSIST_TIMEOUT_MS = 10_000;
const PRECOMPACT_TIMEOUT_MS = 15_000;

/** The main conversation past the anchor, and the anchor it would move to. */
const undistilled = async ($: EngineInterface) => {
  const [messages, held] = await Promise.all([
    $.session.messages({ as: "api" }),
    $.state.get({ plugin: "mimir-cc", key: "distilled" }),
  ]);
  return {
    delta: deltaSince(messages, held.value ?? NO_ANCHOR).map(slim),
    anchor: anchorOf(messages),
  };
};

const distillPayload = async (
  $: EngineInterface,
  messages: readonly unknown[],
  extra: Record<string, unknown> = {},
) => {
  const [session_id, cwd] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
  ]);
  return { session_id, cwd, messages, ...extra };
};

/** Moves the anchor when the binary settled the delta; reports otherwise. */
const settle = async (
  $: EngineInterface,
  leg: string,
  ran: ProcessRunResult,
  anchor: MimirAnchor,
) => {
  if (ran.exitCode !== 0) {
    $.ui.status(`mimir: ${leg} failed (exit ${ran.exitCode})`);
    return;
  }
  if (parseHookOutput(ran.stdout).advance === true)
    await $.state.set({ plugin: "mimir-cc", key: "distilled" }, anchor);
};

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

  on("turn.complete", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const { delta, anchor } = await undistilled($);
    if (delta.length === 0) return next(e);
    const home = (await $.env.get("HOME")) ?? "";
    const ran = await $.process.run(
      mimirCcArgv(home, "persist"),
      mimirCcInit(await distillPayload($, delta), PERSIST_TIMEOUT_MS),
    );
    await settle($, "persist", ran, anchor);
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status("mimir: persist failed");
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    // A precompute installs nothing: the conversation goes on, and its
    // tail is distilled turn by turn as usual.
    if (e.agentId !== undefined || e.trigger === "precompute") return next(e);
    const { delta, anchor } = await undistilled($);
    if (delta.length > 0) {
      const home = (await $.env.get("HOME")) ?? "";
      const ran = await $.process.run(
        mimirCcArgv(home, "precompact"),
        mimirCcInit(
          await distillPayload($, delta, { trigger: e.trigger }),
          PRECOMPACT_TIMEOUT_MS,
        ),
      );
      await settle($, "precompact", ran, anchor);
    }
    const compacted = await next(e);
    if (compacted.messages !== undefined)
      await $.state.set(
        { plugin: "mimir-cc", key: "distilled" },
        anchorOf(compacted.messages),
      );
    return compacted;
  }).catch(($, e, next) => {
    $.ui.status("mimir: precompact failed");
    return next(e);
  });
};
