/**
 * The session lifecycle — turn end and compaction — each handing the
 * subcommand written against it what it needs. Session start runs from
 * the session's first prompt (submit.ts).
 *
 * - `turn.complete` (main loop) → `mimir-cc persist`: the messages since
 *   the last distillation, read from `$.session.messages({ as: "api" })`
 *   and distilled into the local replica.
 * - `session.compact` (main loop, not `precompute`) → `mimir-cc precompact`:
 *   the undistilled tail as `messages`, which the binary takes into the
 *   session journal and extracts facts from; it summarises from the
 *   journal, so no window is sent. Per-turn persist keeps that tail
 *   near-empty, so a non-empty conversation alone is reason to run —
 *   unless a settled run already summarised that same conversation
 *   (`summarised` in `$.state`), as a repeated skipped compaction would
 *   have it. A real compaction records the compacted conversation as
 *   `summarised` at once, since its run covers the window that
 *   conversation replaced.
 *
 * Neither distillation leg holds the user: the hook captures the delta
 * into its payload, marks the run `pending` in `$.state`, and hands the
 * rest to
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
  HookFailure,
  ProcessRunResult,
  Register,
  StateRef,
} from "claude-code";
import type { MimirAnchor, MimirPending } from "../types";
import {
  mimirCcCall,
  PERSIST_COMPLETION_TIMEOUT_MS,
  parseHookOutput,
} from "./binary";
import { distill, type Host, type Leg, precompactLeg } from "./distill";
import { anchorOf, deltaSince, NO_ANCHOR, slim } from "./messages";

/** Off the turn now, so they bound a run, not the user's wait. */
const PERSIST_TIMEOUT_MS = 90_000;
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
const SUMMARISED = {
  plugin: "mimir-cc",
  key: "summarised",
} satisfies StateRef<"mimir-cc", "summarised">;

export const sameAnchor = (a: MimirAnchor | undefined, b: MimirAnchor) =>
  a !== undefined && a.count === b.count && a.mark === b.mark;

/**
 * `$.state` lasts as long as the process, so each anchor is also kept in
 * `$.store` under its session: a resumed session picks up where it stopped
 * instead of distilling its whole window again.
 */
export const ANCHOR_PREFIX = "distilled:";
/** Sessions whose anchors the store keeps; the oldest go first. */
const MAX_KEPT_ANCHORS = 64;

/** A stored value as the anchor it is, or undefined: the store is JSON. */
export const asAnchor = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "count" in value &&
  typeof value.count === "number" &&
  "mark" in value &&
  typeof value.mark === "string"
    ? { count: value.count, mark: value.mark }
    : undefined;

const anchorKey = async ($: EngineInterface) =>
  `${ANCHOR_PREFIX}${await $.session.id()}`;

const keepAnchor = async ($: EngineInterface, anchor: MimirAnchor) => {
  await $.store.set(await anchorKey($), anchor);
  const kept = (await $.store.keys()).filter((key) =>
    key.startsWith(ANCHOR_PREFIX),
  );
  await Promise.all(
    kept
      .slice(0, Math.max(0, kept.length - MAX_KEPT_ANCHORS))
      .map((key) => $.store.delete(key)),
  );
};

/** The anchor `$.state` holds or, in a session just resumed, the store's. */
const heldAnchor = async ($: EngineInterface) => {
  const held = await $.state.get(DISTILLED);
  if (held.value !== undefined) return held;
  const kept = await $.store.get(await anchorKey($));
  return { value: asAnchor(kept), version: held.version };
};

/**
 * The main conversation whole and past the anchor, the anchor it would
 * move to, and the version the anchor stood at when read.
 */
const undistilled = async ($: EngineInterface) => {
  const [messages, held] = await Promise.all([
    $.session.messages({ as: "api" }),
    heldAnchor($),
  ]);
  return {
    isEmpty: messages.length === 0,
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
 * Moves the anchor when the binary settled the delta — only while it still
 * stands at the version the hook read — and reports a failed run. Answers
 * whether the binary settled it, whether or not the anchor moved.
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
    return false;
  }
  if (parseHookOutput(ran.stdout).advance !== true) return false;
  const moved = await $.state.set(DISTILLED, anchor, { ifVersion });
  if (moved.isSet) await keepAnchor($, anchor);
  return true;
};

/**
 * Runs a leg in its own dispatch once the hook has returned, then
 * `onSettled` if the binary settled it. However it ends, its `pending`
 * clears — unless a later leg has claimed it since.
 */
const detach = (
  $: EngineInterface,
  leg: Leg,
  payload: Record<string, unknown>,
  anchor: MimirAnchor,
  versions: { readonly distilled: number; readonly pending: number },
  onSettled: () => Promise<unknown> = async () => undefined,
) => {
  const clear = () =>
    $.state.set(PENDING, null, { ifVersion: versions.pending });
  const host = {
    run: (call) =>
      $.fs
        .write(call.path, call.text)
        .then(() => $.process.run(call.argv, call.init)),
    complete: (request) => $.model.complete(request),
    status: (text) => $.ui.status(text),
  } satisfies Host;
  $.clock.after(0, () =>
    distill(host, leg, payload)
      .then((ran) => settle($, leg.name, ran, anchor, versions.distilled))
      .then((settled) => (settled ? onSettled() : undefined))
      .then(clear, (reason) => {
        // The reason leads: a status line is cut short, and the leg's name
        // is the part a reader can do without.
        $.ui.status(`mimir: ${String(reason)} (${leg.name} run failed)`);
        return clear();
      })
      .then(undefined, () => {
        $.ui.status(`mimir: ${leg.name} could not clear pending`);
      }),
  );
};

/** Why a hook's `.catch` is running: the engine's kind and what it caught. */
const caught = (error: HookFailure) =>
  error.message === undefined ? error.kind : `${error.kind}: ${error.message}`;

export const registerLifecycle: Register = (on) => {
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
        call: (payload) =>
          mimirCcCall(home, "persist", payload, PERSIST_TIMEOUT_MS),
        completionTimeoutMs: PERSIST_COMPLETION_TIMEOUT_MS,
      },
      await distillPayload($, delta),
      anchor,
      { distilled: version, pending: claimed.version },
    );
    return next(e);
  }).catch(($, e, next) => {
    $.ui.status(`mimir: persist hook failed (${caught(next.error)})`);
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    // A precompute installs nothing: the conversation goes on, and its
    // tail is distilled turn by turn as usual.
    if (e.agentId !== undefined || e.trigger === "precompute") return next(e);
    // The tail is captured before the engine discards it; its run waits
    // until after the re-anchor, whose write its own then misses.
    const [{ isEmpty, delta, anchor, version }, summarised] = await Promise.all(
      [undistilled($), $.state.get(SUMMARISED)],
    );
    // A skipped compaction re-anchors nothing; its repeat over a
    // conversation already summarised would only run the same again.
    const payload =
      !isEmpty && !sameAnchor(summarised.value, anchor)
        ? await distillPayload($, delta, { trigger: e.trigger })
        : undefined;
    const compacted = await next(e);
    const reanchored =
      compacted.messages !== undefined
        ? anchorOf(compacted.messages)
        : undefined;
    if (reanchored !== undefined) {
      await $.state.set(DISTILLED, reanchored);
      await keepAnchor($, reanchored);
      // The compacted conversation stands for the window this run
      // summarises, settled or not, so an end with nothing said since does
      // not summarise it again (session-end.ts).
      await $.state.set(SUMMARISED, reanchored);
      // The next prompt is a reset: a voice anchor and the boot block
      // (submit.ts).
      await $.state.set({ plugin: "mimir-cc", key: "reanchor" }, true);
    }
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
        precompactLeg(home),
        payload,
        anchor,
        { distilled: version, pending: claimed.version },
        // Only a skipped compaction leaves this conversation in place to be
        // repeated; after a real one `summarised` is already the compacted
        // conversation's.
        reanchored === undefined
          ? () => $.state.set(SUMMARISED, anchor)
          : undefined,
      );
    }
    return compacted;
  }).catch(($, e, next) => {
    $.ui.status(`mimir: precompact hook failed (${caught(next.error)})`);
    return next(e);
  });
};
