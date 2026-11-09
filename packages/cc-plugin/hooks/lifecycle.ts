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
 * (messages.ts). With no extraction endpoint configured, a leg's first run
 * answers `requests` — the prompts it rendered — which run on the session's
 * own model (`$.model.complete`, haiku) before a second run parses and
 * stores the replies. The binary answers `{ advance }`: true once the delta is
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
import {
  type Completion,
  completionAsk,
  completionOutcome,
  completionRefusal,
  mimirCcArgv,
  mimirCcInit,
  PERSIST_COMPLETION_TIMEOUT_MS,
  PRECOMPACT_COMPLETION_TIMEOUT_MS,
  parseHookOutput,
} from "./binary";
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
  // host_completions tells the binary this module runs its `requests`; a
  // binary that never sees it keeps the single-phase behaviour.
  return { session_id, cwd, messages, ...extra, host_completions: true };
};

/**
 * Runs a distillation leg. When it answers `requests`, each runs on the
 * session's model in parallel and the leg runs again with the replies as
 * `completions`; the last run is the one to settle on. A completion the
 * engine refuses to send goes back as its error, so the others still land.
 */
const distill = async (
  $: EngineInterface,
  leg: {
    readonly name: string;
    readonly argv: readonly string[];
    readonly timeoutMs: number;
    readonly completionTimeoutMs: number;
  },
  payload: Record<string, unknown>,
) => {
  const run = (input: unknown) =>
    $.process.run(leg.argv, mimirCcInit(input, leg.timeoutMs));
  const first = await run(payload);
  if (first.exitCode !== 0) return first;
  const { requests } = parseHookOutput(first.stdout);
  if (requests === undefined) return first;
  const replies = await Promise.all(
    Object.entries(requests).map(async ([key, request]) => {
      const outcome = await $.model
        .complete(completionAsk(request, leg.completionTimeoutMs))
        .then(completionOutcome, completionRefusal);
      return [key, outcome] satisfies [string, Completion];
    }),
  );
  const second = await run({
    ...payload,
    completions: Object.fromEntries(replies),
  });
  if (
    second.exitCode === 0 &&
    parseHookOutput(second.stdout).requests !== undefined
  )
    $.ui.status(`mimir: ${leg.name} asked for completions twice`);
  return second;
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
    const ran = await distill(
      $,
      {
        name: "persist",
        argv: mimirCcArgv(home, "persist"),
        timeoutMs: PERSIST_TIMEOUT_MS,
        completionTimeoutMs: PERSIST_COMPLETION_TIMEOUT_MS,
      },
      await distillPayload($, delta),
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
      const ran = await distill(
        $,
        {
          name: "precompact",
          argv: mimirCcArgv(home, "precompact"),
          timeoutMs: PRECOMPACT_TIMEOUT_MS,
          completionTimeoutMs: PRECOMPACT_COMPLETION_TIMEOUT_MS,
        },
        await distillPayload($, delta, { trigger: e.trigger }),
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
