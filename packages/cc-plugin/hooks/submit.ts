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
 *   rotation, this file the cadence. The first prompt after a compaction
 *   (`reanchor`, set in lifecycle.ts) is an anchor turn too, and the
 *   cadence restarts from it: the summary that replaced the conversation
 *   carries none of the voice.
 *
 * Both legs run at once and fail open leg by leg: a binary that errors
 * or times out costs the turn that leg, never the prompt, and the
 * counter still advances so the next anchor lands on time.
 */

import type { ProcessRunResult, Register } from "claude-code";
import { mimirCcArgv, mimirCcInit, readHookOutput } from "./binary";

const RETRIEVE_TIMEOUT_MS = 15_000;
const ANCHOR_TIMEOUT_MS = 10_000;
const UNREADABLE_RETRIEVE_STATUS = "mimir: retrieve failed (output not JSON)";
/** plugin-core's DEFAULT_ANCHOR_INTERVAL, which the sandbox cannot import. */
const DEFAULT_INTERVAL = 3;

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

export const registerSubmit: Register = (on) => {
  on("prompt.submit", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const sessionId = await $.session.id();

    const interval = anchorInterval(await $.env.get("MIMIR_ANCHOR_INTERVAL"));
    const [held, reanchor, owed] = await Promise.all([
      $.state.get({ plugin: "mimir-cc", key: "turn" }),
      $.state.get({ plugin: "mimir-cc", key: "reanchor" }),
      $.state.get({ plugin: "mimir-cc", key: "summaryOwed" }),
    ]);
    const counted = (held.value ?? 0) + 1;
    // After a compaction this prompt is an anchor turn whatever the count.
    const isReanchor = reanchor.value === true;
    const turn = isReanchor ? nextAnchorTurn(counted, interval) : counted;
    await $.state.set({ plugin: "mimir-cc", key: "turn" }, turn);
    if (isReanchor) {
      await $.state.set({ plugin: "mimir-cc", key: "reanchor" }, false);
    }
    const nth = anchorIndexFor(turn, interval);
    // No turn counted yet (the session's first prompt), or the last
    // session's summary is still owed from an earlier one.
    const sessionStart = held.value === undefined || owed.value === true;

    const payload = {
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt: e.text,
      cwd: await $.session.cwd(),
      // The compaction replaced the window, so retrieval may send again
      // what it sent before.
      window_reset: isReanchor,
      // Asks for the active project's newest summary.
      session_start: sessionStart,
    };
    const [retrieve, anchor] = await Promise.allSettled([
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
      await $.state.set({ plugin: "mimir-cc", key: "summaryOwed" }, !settled);
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
