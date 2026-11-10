/**
 * The `prompt.submit` hook — everything Mimir attaches to a developer
 * prompt. One hook, because the engine takes one unmatched hook per
 * event from a module.
 *
 * - The turn count, in `$.state` (`mimir-cc.turn`, types/index.d.ts).
 * - Retrieval, every turn: `mimir-cc retrieve` with the UserPromptSubmit
 *   payload. Its `additionalContext` becomes prompt context — what the
 *   model reads beside the prompt and the developer never sees — and its
 *   `systemMessage` (the "↻ Retrieved N memories" line) the status line.
 * - A voice anchor every MIMIR_ANCHOR_INTERVAL turns (default 5):
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
import { mimirCcArgv, mimirCcInit, parseHookOutput } from "./binary";

const RETRIEVE_TIMEOUT_MS = 15_000;
const ANCHOR_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL = 5;

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
    const [held, reanchor] = await Promise.all([
      $.state.get({ plugin: "mimir-cc", key: "turn" }),
      $.state.get({ plugin: "mimir-cc", key: "reanchor" }),
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

    const payload = {
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt: e.text,
      cwd: await $.session.cwd(),
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

    const retrieved = legOutcome("retrieve", retrieve);
    if (retrieved.status !== undefined) $.ui.status(retrieved.status);
    if (retrieved.stdout !== undefined) {
      const out = parseHookOutput(retrieved.stdout);
      if (out.systemMessage !== undefined) $.ui.status(out.systemMessage);
      const extra = out.hookSpecificOutput?.additionalContext;
      if (extra !== undefined) context.push(extra);
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
