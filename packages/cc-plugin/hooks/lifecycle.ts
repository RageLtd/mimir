/**
 * The session lifecycle — session start, turn end and compaction — each
 * handing the subcommand written against it what it needs.
 *
 * - `classic.SessionStart` → `mimir-cc session-start`: on startup or
 *   resume, detaches a worker that reconciles keys, syncs the org replica
 *   and reindexes the project, then returns at once so the first prompt
 *   is never behind it. The classic event is the bridge because it
 *   carries `source`, which the engine's own `session.start` does not.
 *   The same hook asks for the binary released with this plugin.
 * - `turn.complete` (main loop) → `mimir-cc persist`: the messages since
 *   the last distillation, read from `$.session.messages({ as: "api" })`
 *   and distilled into the local replica.
 * - `session.compact` (main loop, not `precompute`) → `mimir-cc precompact`:
 *   the whole window as `window`, summarised before the engine discards
 *   it, and the undistilled tail as `messages`, whose facts persist has
 *   not yet extracted. Per-turn persist keeps that tail near-empty, so a
 *   non-empty window alone is reason to run — unless a settled run already
 *   summarised that same window (`summarised` in `$.state`), as a repeated
 *   skipped compaction would have it. A real compaction records the
 *   compacted conversation as `summarised` at once, since its run covers
 *   the window that conversation replaced.
 *
 * Neither distillation leg holds the user: the hook captures the delta
 * (and, for precompact, the whole window) into its payload, marks the run
 * `pending` in `$.state`, and hands the rest to
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
import {
  FETCH_TIMEOUT_MS,
  manifestPath,
  manifestVersion,
  pinArgv,
} from "./pin-binary";

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
const SUMMARISED = {
  plugin: "mimir-cc",
  key: "summarised",
} satisfies StateRef<"mimir-cc", "summarised">;

export const sameAnchor = (a: MimirAnchor | undefined, b: MimirAnchor) =>
  a !== undefined && a.count === b.count && a.mark === b.mark;

type Leg = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly completionTimeoutMs: number;
};

/**
 * `$.state` lasts as long as the process, so each anchor is also kept in
 * `$.store` under its session: a resumed session picks up where it stopped
 * instead of distilling its whole window again.
 */
const ANCHOR_PREFIX = "distilled:";
/** Sessions whose anchors the store keeps; the oldest go first. */
const MAX_KEPT_ANCHORS = 64;

/** A stored value as the anchor it is, or undefined: the store is JSON. */
const asAnchor = (value: unknown) =>
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
    window: messages.map(slim),
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
  $.clock.after(0, () =>
    distill($, leg, payload)
      .then((ran) => settle($, leg.name, ran, anchor, versions.distilled))
      .then((settled) => (settled ? onSettled() : undefined))
      .then(clear, () => {
        $.ui.status(`mimir: ${leg.name} failed`);
        return clear();
      })
      .then(undefined, () => {
        $.ui.status(`mimir: ${leg.name} could not clear pending`);
      }),
  );
};

/**
 * Asks for the binary released with this plugin (pin-binary.ts), in a
 * dispatch of its own: a download takes seconds. Each hook runs the
 * binary afresh, so they pick the fetched build up as soon as it lands;
 * the MCP servers already running keep the old one until the next session.
 */
const pinBinary = async ($: EngineInterface) => {
  const root = $.plugin.root;
  const version = await $.fs
    .read(manifestPath(root))
    .then(manifestVersion)
    .catch(() => undefined);
  if (version === undefined) {
    $.ui.status("mimir: plugin.json carries no version");
    return;
  }
  const failed = (detail = "") =>
    $.ui.status(
      `mimir: could not fetch the mimir-cc ${version} binary${detail}`,
    );
  $.clock.after(0, () =>
    $.process.run(pinArgv(root, version), { timeoutMs: FETCH_TIMEOUT_MS }).then(
      (ran) => {
        if (ran.exitCode !== 0) failed(` (exit ${ran.exitCode})`);
      },
      () => failed(),
    ),
  );
};

export const registerLifecycle: Register = (on) => {
  on("classic.SessionStart", async ($, e, next) => {
    await pinBinary($);
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
    // The window is captured before the engine discards it; its run waits
    // until after the re-anchor, whose write its own then misses.
    const [{ window, delta, anchor, version }, summarised] = await Promise.all([
      undistilled($),
      $.state.get(SUMMARISED),
    ]);
    // A skipped compaction re-anchors nothing; its repeat over a window
    // already summarised would only store the same summary again.
    const payload =
      window.length > 0 && !sameAnchor(summarised.value, anchor)
        ? await distillPayload($, delta, { trigger: e.trigger, window })
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
      // The next prompt gets a voice anchor (submit.ts).
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
        {
          name: "precompact",
          argv: mimirCcArgv(home, "precompact"),
          timeoutMs: PRECOMPACT_TIMEOUT_MS,
          completionTimeoutMs: PRECOMPACT_COMPLETION_TIMEOUT_MS,
        },
        payload,
        anchor,
        { distilled: version, pending: claimed.version },
        // Only a skipped compaction leaves this window in the conversation
        // to be repeated; after a real one `summarised` is already the
        // compacted conversation's.
        reanchored === undefined
          ? () => $.state.set(SUMMARISED, anchor)
          : undefined,
      );
    }
    return compacted;
  }).catch(($, e, next) => {
    $.ui.status("mimir: precompact failed");
    return next(e);
  });
};
