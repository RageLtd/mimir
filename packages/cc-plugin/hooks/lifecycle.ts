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
 * Neither distillation leg holds the user: the hook captures the delta and
 * its payload, marks the run `pending` in `$.state`, and hands the rest to
 * `$.clock.after(0, …)`, a dispatch of its own that runs once the hook has
 * returned. One persist is in flight at a time — a turn that ends while one
 * is pending schedules nothing, and the next turn's delta carries its
 * messages. A pending older than PENDING_STALE_MS is dead (its session
 * ended mid-run) and blocks nothing.
 *
 * Where the last distillation stopped lives in `$.state` as an anchor
 * (messages.ts). With no extraction endpoint configured, a leg's first run
 * answers `requests` — the prompts it rendered — which run on the session's
 * own model (`$.model.complete`, haiku) before a second run parses and
 * stores the replies. The binary answers `{ advance }`: true once the delta is
 * settled — distilled, or skipped on purpose — false when extraction
 * failed and the next turn should carry the same messages again. After a
 * compaction the anchor is the compacted conversation whatever happened,
 * so the engine's own summary is never distilled as if it were a turn: a
 * deferred run writes its anchor only on the version its hook read, which
 * a re-anchor has moved past.
 *
 * None of these can change what the engine does; a failure shows as a
 * status line and the event passes on.
 */

import type {
  EngineInterface,
  ProcessRunResult,
  Register,
  StateRef,
} from "claude-code";
import type { MimirAnchor, MimirPending } from "../types";
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
/** Off the turn now, so they bound a run, not the user's wait. */
const PERSIST_TIMEOUT_MS = 90_000;
/** BYOK summarise (120 s) then extract (60 s), sequential in the binary. */
const PRECOMPACT_TIMEOUT_MS = 200_000;
/**
 * A worst-case persist (two runs and a completion between them) with a
 * minute's slack: a pending this old outlived its session. A pathological
 * precompact (up to 2 × 200 s + 60 s) can outlive it and overlap a persist;
 * its duplicate facts dedupe and both anchor writes are version-checked.
 */
export const PENDING_STALE_MS =
  2 * PERSIST_TIMEOUT_MS + PERSIST_COMPLETION_TIMEOUT_MS + 60_000;

const DISTILLED = {
  plugin: "mimir-cc",
  key: "distilled",
} satisfies StateRef<"mimir-cc", "distilled">;
const PENDING = {
  plugin: "mimir-cc",
  key: "pending",
} satisfies StateRef<"mimir-cc", "pending">;

type Leg = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly completionTimeoutMs: number;
};

/**
 * The main conversation past the anchor, the anchor it would move to, and
 * the version the anchor stood at when read.
 */
const undistilled = async ($: EngineInterface) => {
  const [messages, held] = await Promise.all([
    $.session.messages({ as: "api" }),
    $.state.get(DISTILLED),
  ]);
  return {
    delta: deltaSince(messages, held.value ?? NO_ANCHOR).map(slim),
    anchor: anchorOf(messages),
    version: held.version,
  };
};

const isInFlight = (pending: MimirPending | null | undefined, now: number) =>
  pending != null && now - pending.at < PENDING_STALE_MS;

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
  leg: Leg,
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

/**
 * Moves the anchor when the binary settled the delta — only while it still
 * stands at the version the hook read — and reports a failed run.
 */
const settle = async (
  $: EngineInterface,
  leg: string,
  ran: ProcessRunResult,
  anchor: MimirAnchor,
  ifVersion: number,
) => {
  if (ran.exitCode !== 0) {
    $.ui.status(`mimir: ${leg} failed (exit ${ran.exitCode})`);
    return;
  }
  if (parseHookOutput(ran.stdout).advance === true)
    await $.state.set(DISTILLED, anchor, { ifVersion });
};

/**
 * Runs a leg in its own dispatch once the hook has returned. However it
 * ends, its `pending` clears — unless a later leg has claimed it since.
 */
const detach = (
  $: EngineInterface,
  leg: Leg,
  payload: Record<string, unknown>,
  anchor: MimirAnchor,
  versions: { readonly distilled: number; readonly pending: number },
) => {
  const clear = () =>
    $.state.set(PENDING, null, { ifVersion: versions.pending });
  $.clock.after(0, () =>
    distill($, leg, payload)
      .then((ran) => settle($, leg.name, ran, anchor, versions.distilled))
      .then(clear, () => {
        $.ui.status(`mimir: ${leg.name} failed`);
        return clear();
      })
      .then(undefined, () => {
        $.ui.status(`mimir: ${leg.name} could not clear pending`);
      }),
  );
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
    const { delta, anchor, version } = await undistilled($);
    if (delta.length === 0) return next(e);
    const [pending, now] = await Promise.all([
      $.state.get(PENDING),
      $.clock.now(),
    ]);
    if (isInFlight(pending.value, now)) return next(e);
    const claimed = await $.state.set(
      PENDING,
      { anchor, at: now },
      { ifVersion: pending.version },
    );
    if (!claimed.isSet) return next(e);
    const home = (await $.env.get("HOME")) ?? "";
    detach(
      $,
      {
        name: "persist",
        argv: mimirCcArgv(home, "persist"),
        timeoutMs: PERSIST_TIMEOUT_MS,
        completionTimeoutMs: PERSIST_COMPLETION_TIMEOUT_MS,
      },
      await distillPayload($, delta),
      anchor,
      { distilled: version, pending: claimed.version },
    );
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status("mimir: persist failed");
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    // A precompute installs nothing: the conversation goes on, and its
    // tail is distilled turn by turn as usual.
    if (e.agentId !== undefined || e.trigger === "precompute") return next(e);
    // The tail is captured before the engine discards it; its run waits
    // until after the re-anchor, whose write its own then misses.
    const { delta, anchor, version } = await undistilled($);
    const payload =
      delta.length > 0
        ? await distillPayload($, delta, { trigger: e.trigger })
        : undefined;
    const compacted = await next(e);
    if (compacted.messages !== undefined)
      await $.state.set(DISTILLED, anchorOf(compacted.messages));
    if (payload !== undefined) {
      const home = (await $.env.get("HOME")) ?? "";
      // Always scheduled: losing the window's summary is worse than a rare
      // overlap with a persist in flight, whose duplicate facts dedupe.
      // After a skipped compaction nothing re-anchors, so an in-flight
      // persist and this run share a `distilled` version and whichever
      // settles second misses its anchor write — benign: the next delta
      // re-covers the tail and its facts dedupe.
      const claimed = await $.state.set(PENDING, {
        anchor,
        at: await $.clock.now(),
      });
      detach(
        $,
        {
          name: "precompact",
          argv: mimirCcArgv(home, "precompact"),
          timeoutMs: PRECOMPACT_TIMEOUT_MS,
          completionTimeoutMs: PRECOMPACT_COMPLETION_TIMEOUT_MS,
        },
        payload,
        anchor,
        { distilled: version, pending: claimed.version },
      );
    }
    return compacted;
  }).catch(($, e, next) => {
    $.ui.status("mimir: precompact failed");
    return next(e);
  });
};
