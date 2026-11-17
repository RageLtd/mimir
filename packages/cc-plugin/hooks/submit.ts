/**
 * The `prompt.submit` hook — everything Mimir attaches to a developer
 * prompt. One hook, because the engine takes one unmatched hook per
 * event from a module.
 *
 * - The turn count, in `$.state` (`mimir-cc.turn`, types/index.d.ts).
 * - Retrieval, every turn: `mimir-cc retrieve` with the UserPromptSubmit
 *   payload, plus `session_start` on the session's first prompt (no turn
 *   counted yet). Its `additionalContext` becomes prompt context — what the
 *   model reads beside the prompt and the developer never sees — and its
 *   `systemMessage` (the "↻ Retrieved N memories" line) the status line.
 * - The last session's summary stays owed (`mimir-cc.summaryOwed`) until a
 *   `session_start` retrieve settles it. While its summary-pending mark is
 *   live, retrieve answers `summaryPending` whatever the distance gate
 *   admitted — a summary near the prompt is still injected, but it does
 *   not settle the debt — and it answers the flag alone when its own
 *   retrieval failed. A retrieve that exits non-zero, cannot run or prints
 *   what is not JSON leaves the summary owed too. Each owed prompt is sent
 *   as `session_start` again; one readable answer without the flag clears
 *   the debt.
 * - A voice anchor every MIMIR_ANCHOR_INTERVAL turns (default 3):
 *   `mimir-cc voice-anchor --session <id> --nth <n>`, the next exchange
 *   in the session's rotation, attached after the retrieval. The
 *   recency-slot persona refresh; the binary owns the library and the
 *   rotation, this file the cadence.
 * - A reset: a prompt that follows the `reanchor` flag — set by a
 *   compaction (lifecycle.ts) and by a `/clear` or a resume
 *   (session-end.ts), absent where a managed organization passes those
 *   hooks over this plugin — or whose messages no longer carry on the
 *   window the last prompt saw (`mimir-cc.window`, messages.ts
 *   `continuesWindow`): shorter, or another message where its last one
 *   stood. A slash command or a prompt typed mid-turn grows no window, so
 *   the prompt after it is no reset. A reset is an anchor turn whatever
 *   the count, and the cadence restarts from it: the window that replaced
 *   the conversation carries none of the voice. Retrieval is told
 *   (`window_reset`).
 * - The window is read as `$.session.messages()`'s rows, not the API
 *   form: only its length and one message's mark are used, and the rows
 *   carry no media. A read that fails costs only the reset check: one
 *   status line, the flag still honoured, the turn counted, the recorded
 *   window kept.
 * - The boot block (boot.ts) on the session's first prompt and on every
 *   reset, so the developer's profile outlives the window it was sent in.
 * - Session start: `mimir-cc session-start` (session-start.ts) on the
 *   process's first prompt (no turn counted yet) and on the first prompt
 *   after a resume (`mimir-cc.resumed`, set in session-end.ts), with that
 *   session's id and cwd; not after a `/clear`. The binary pin
 *   (pin-binary.ts) on the process's first prompt only. Each runs in a
 *   dispatch of its own once the hook has returned. `classic.SessionStart`
 *   is passed over plugins a person installs where an organization
 *   manages Claude Code, so neither hangs off it.
 *
 * The legs run at once and fail open leg by leg: a binary that errors
 * or times out costs the turn that leg, never the prompt, and the
 * counter still advances so the next anchor lands on time. Session start
 * and the pin fail open too, as a status line.
 *
 * Limits:
 * - A boot-context run that fails on a first prompt or a reset is not
 *   retried: the window goes without the boot block until the next reset.
 * - Without the `reanchor` flag, a replaced window is missed when it is
 *   no shorter than the one the last prompt saw and keeps that window's
 *   last message at the same position (a compaction that swapped earlier
 *   messages one for one), or, at the engine's 4096-message cap, keeps
 *   that message anywhere.
 * - `session-start` for a resumed session depends on `session.end`
 *   reaching this plugin (the `resumed` flag, session-end.ts): where an
 *   organization passes that event over the plugin, a resumed session gets
 *   no re-index or sync for its cwd until the next process.
 * - A message with no text (tool use or tool results alone) marks as its
 *   bare role, so when the last message seen was one, any message of that
 *   role at its position passes for it.
 */

import type {
  EngineInterface,
  ProcessRunResult,
  Register,
  StateRef,
} from "claude-code";
import { mimirCcArgv, mimirCcInit, readHookOutput } from "./binary";
import { bootCall } from "./boot";
import { anchorOf, continuesWindow } from "./messages";
import {
  FETCH_TIMEOUT_MS,
  manifestPath,
  manifestVersion,
  pinArgv,
} from "./pin-binary";
import { sessionStartCall } from "./session-start";

const RETRIEVE_TIMEOUT_MS = 15_000;
const ANCHOR_TIMEOUT_MS = 10_000;
const UNREADABLE_RETRIEVE_STATUS = "mimir: retrieve failed (output not JSON)";
const UNREADABLE_WINDOW_STATUS =
  "mimir: could not read the conversation; no reset check this prompt";
const SESSION_START_FAILED = "mimir: session start failed";
/** plugin-core's DEFAULT_ANCHOR_INTERVAL, which the sandbox cannot import. */
const DEFAULT_INTERVAL = 3;

// The plugin name stays a literal in each reference: `claude plugin
// validate` refuses a `$.state` reference whose plugin or key is not one.
const TURN = {
  plugin: "mimir-cc",
  key: "turn",
} satisfies StateRef<"mimir-cc", "turn">;
const REANCHOR = {
  plugin: "mimir-cc",
  key: "reanchor",
} satisfies StateRef<"mimir-cc", "reanchor">;
const RESUMED = {
  plugin: "mimir-cc",
  key: "resumed",
} satisfies StateRef<"mimir-cc", "resumed">;
const SUMMARY_OWED = {
  plugin: "mimir-cc",
  key: "summaryOwed",
} satisfies StateRef<"mimir-cc", "summaryOwed">;
const WINDOW = {
  plugin: "mimir-cc",
  key: "window",
} satisfies StateRef<"mimir-cc", "window">;

/** `MIMIR_ANCHOR_INTERVAL` as a positive integer, else the default. */
export const anchorInterval = (raw: string | undefined) => {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : DEFAULT_INTERVAL;
};

/** The anchor turn at or after `turn`: where a re-anchor moves the count. */
export const nextAnchorTurn = (turn: number, interval: number) =>
  Math.ceil(turn / interval) * interval;

/** Which anchor a turn gets, or null when it is not an anchor turn. */
export const anchorIndexFor = (turn: number, interval: number) =>
  turn % interval === 0 ? turn / interval - 1 : null;

/** One leg's outcome: its stdout on success, a status line otherwise. */
const legOutcome = (
  name: string,
  settled: PromiseSettledResult<ProcessRunResult | null>,
) => {
  const ran = settled.status === "fulfilled" ? settled.value : null;
  const status =
    settled.status === "rejected"
      ? `mimir: ${name} failed`
      : ran !== null && ran.exitCode !== 0
        ? `mimir: ${name} failed (exit ${ran.exitCode})`
        : undefined;
  return { status, stdout: status === undefined ? ran?.stdout : undefined };
};

/**
 * Asks for the binary released with this plugin (pin-binary.ts). Each hook
 * runs the binary afresh, so they pick the fetched build up as soon as it
 * lands; the MCP servers already running keep the old one until the next
 * session.
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
  await $.process
    .run(pinArgv(root, version), { timeoutMs: FETCH_TIMEOUT_MS })
    .then(
      (ran) => {
        if (ran.exitCode !== 0) failed(` (exit ${ran.exitCode})`);
      },
      () => failed(),
    );
};

/**
 * Session start, and on the process's first prompt the pin, each in a
 * dispatch of its own once the hook has returned: the prompt waits on
 * neither, and a download takes seconds.
 */
const startSession = (
  $: EngineInterface,
  call: ReturnType<typeof sessionStartCall>,
  pin: boolean,
) => {
  $.clock.after(0, () =>
    $.process.run(call.argv, call.init).then(
      (ran) => {
        if (ran.exitCode !== 0)
          $.ui.status(`${SESSION_START_FAILED} (exit ${ran.exitCode})`);
      },
      () => {
        $.ui.status(SESSION_START_FAILED);
      },
    ),
  );
  if (pin)
    $.clock.after(0, () =>
      pinBinary($).catch(() => {
        $.ui.status("mimir: could not fetch the mimir-cc binary");
      }),
    );
};

export const registerSubmit: Register = (on) => {
  on("prompt.submit", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const sessionId = await $.session.id();
    const cwd = await $.session.cwd();

    const interval = anchorInterval(await $.env.get("MIMIR_ANCHOR_INTERVAL"));
    const [held, reanchor, resumed, owed, seen, messages] = await Promise.all([
      $.state.get(TURN),
      $.state.get(REANCHOR),
      $.state.get(RESUMED),
      $.state.get(SUMMARY_OWED),
      $.state.get(WINDOW),
      $.session.messages().then(
        (rows) => ({ rows, error: undefined }),
        (error: unknown) => ({ rows: undefined, error }),
      ),
    ]);
    if (messages.error !== undefined) $.ui.status(UNREADABLE_WINDOW_STATUS);
    const isFirstPrompt = held.value === undefined;
    // The flag and the window can both see one reset: still one.
    const isReset =
      reanchor.value === true ||
      (messages.rows !== undefined &&
        seen.value !== undefined &&
        !continuesWindow(messages.rows, seen.value));
    const counted = (held.value ?? 0) + 1;
    const turn = isReset ? nextAnchorTurn(counted, interval) : counted;
    await $.state.set(TURN, turn);
    if (messages.rows !== undefined)
      await $.state.set(WINDOW, anchorOf(messages.rows));
    if (reanchor.value === true) await $.state.set(REANCHOR, false);
    if (resumed.value === true) await $.state.set(RESUMED, false);
    if (isFirstPrompt || resumed.value === true)
      startSession($, sessionStartCall(home, cwd, sessionId), isFirstPrompt);
    const nth = anchorIndexFor(turn, interval);
    // No turn counted yet (the session's first prompt), or the last
    // session's summary is still owed from an earlier one.
    const sessionStart = isFirstPrompt || owed.value === true;

    const payload = {
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt: e.text,
      cwd,
      // The window was replaced, so retrieval may send again what it sent
      // before.
      window_reset: isReset,
      // Asks for the active project's newest summary.
      session_start: sessionStart,
    };
    const boot = bootCall(home, cwd, sessionId);
    const [booted, retrieve, anchor] = await Promise.allSettled([
      isFirstPrompt || isReset ? $.process.run(boot.argv, boot.init) : null,
      $.process.run(
        mimirCcArgv(home, "retrieve"),
        mimirCcInit(payload, RETRIEVE_TIMEOUT_MS),
      ),
      nth === null
        ? null
        : $.process.run(
            [
              ...mimirCcArgv(home, "voice-anchor"),
              "--session",
              sessionId,
              "--nth",
              String(nth),
            ],
            mimirCcInit(undefined, ANCHOR_TIMEOUT_MS),
          ),
    ]);

    const context = [...(e.context ?? [])];

    const bootRan = legOutcome("boot context", booted);
    if (bootRan.status !== undefined) $.ui.status(bootRan.status);
    const bootBlock = bootRan.stdout?.trim() ?? "";
    if (bootBlock.length > 0) context.push(bootBlock);

    const ran = legOutcome("retrieve", retrieve);
    const read =
      ran.stdout === undefined ? null : await readHookOutput(ran.stdout);
    // Stdout that is not JSON fails the leg like a non-zero exit.
    const retrieved =
      read === null || read.error === null
        ? ran
        : { status: UNREADABLE_RETRIEVE_STATUS };
    if (retrieved.status !== undefined) $.ui.status(retrieved.status);
    const out = read?.output ?? null;
    if (out !== null) {
      if (out.systemMessage !== undefined) $.ui.status(out.systemMessage);
      const extra = out.hookSpecificOutput?.additionalContext;
      if (extra !== undefined) context.push(extra);
    }
    if (sessionStart) {
      // Settled only by a retrieve that ran, answered readably and did not
      // say the summary is still owed; a failed leg leaves it owed.
      const settled =
        retrieved.status === undefined && out?.summaryPending !== true;
      await $.state.set(SUMMARY_OWED, !settled);
    }

    const anchored = legOutcome("voice anchor", anchor);
    if (anchored.status !== undefined) $.ui.status(anchored.status);
    const block = anchored.stdout?.trim() ?? "";
    if (block.length > 0) context.push(block);

    return context.length === (e.context?.length ?? 0)
      ? next(e)
      : next({ ...e, context });
  }).catch(($, e, next) => {
    $.ui.status("mimir: prompt hook failed");
    return next(e);
  });
};
