/**
 * The window seen from `prompt.submit` when something other than a turn
 * comes between two prompts. A slash command or a prompt typed mid-turn
 * grows no conversation, so the prompt after it seeing the same window is
 * no reset. A resume puts another session's messages in the window, a
 * reset. A window that cannot be read costs the prompt nothing.
 */

import { expect, test } from "claude-code/testing";
import {
  anchorNths,
  BOOT,
  CONTEXT,
  converse,
  ending,
  exchange,
  exited,
  midTurn,
  RETRIEVED_STATUS,
  retrieved,
  runsOf,
  SESSION,
  slashCommand,
  submitSession,
  submitted,
  windowResets,
} from "./__tests__/submit-fixtures";

/** Four, so a reset on a non-anchor turn moves the cadence visibly. */
const EVERY_FOURTH = { MIMIR_ANCHOR_INTERVAL: "4" };

const answering = (sub: string) =>
  sub === "boot-context"
    ? exited(0, `${BOOT}\n`)
    : sub === "retrieve"
      ? exited(0, retrieved(CONTEXT, RETRIEVED_STATUS))
      : exited(0);

const contextOf = (result: object) =>
  "context" in result ? result.context : undefined;

test("a slash command, then a prompt seeing the same window, is no reset", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  say(seen);
  await $.prompt.submit(slashCommand("status"));
  // The command grew no conversation: the next prompt sees the same window.
  say(seen);
  const result = await $.prompt.submit(submitted("question 3"));

  expect(runsOf(runs, "boot-context")).toHaveLength(1);
  expect(windowResets(runs)).not.toContain(true);
  expect(contextOf(result)).not.toContain(BOOT);
});

test("a prompt typed mid-turn, seeing the window the prompt before it saw, is no reset", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 1);

  say(seen);
  await $.prompt.submit(submitted("question 2"));
  // Typed while prompt 2's turn runs: its exchange is not in the window yet.
  const result = await $.prompt.submit(midTurn("and also this", "turn-2"));

  expect(runsOf(runs, "boot-context")).toHaveLength(1);
  expect(windowResets(runs)).toEqual([false, false, false]);
  expect(contextOf(result)).not.toContain(BOOT);
});

test("a prompt seeing exactly the window the previous prompt saw is no reset, and moves no cadence", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  // Prompt 3 sees the window prompt 2 saw, exchange 2 not appended.
  say(seen.slice(0, -2));
  const result = await $.prompt.submit(submitted("question 2 again"));

  expect(runsOf(runs, "boot-context")).toHaveLength(1);
  expect(windowResets(runs)).toEqual([false, false, false]);
  // Turn 3 is no anchor turn; a reset would have moved it up to 4.
  expect(anchorNths(runs)).toEqual([]);
  expect(result).toEqual({ text: "question 2 again", context: [CONTEXT] });
});

const RESUMED = "session-resumed";
const RESUMED_CWD = "/work/elsewhere";

test("a resume in the same process makes its first prompt a reset", async ($, on) => {
  const { say, runs, switchTo } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  // The resumed session's own messages, longer than the window before.
  await $.session.end(ending("resume", SESSION));
  switchTo(RESUMED, RESUMED_CWD);
  say([11, 12, 13, 14, 15].flatMap(exchange));
  const result = await $.prompt.submit(submitted("back to this"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, true]);
  // Turn 3 moved up to the next anchor turn, 4.
  expect(anchorNths(runs)).toEqual(["0"]);
  expect(contextOf(result)).toContain(BOOT);
  expect(contextOf(result)).toContain(CONTEXT);
});

const MIMIR_STATUS = /^mimir: /;

test("a window that cannot be read costs the prompt nothing and says so once", async ($, on) => {
  const { say, runs, statuses, unreadable } = submitSession(
    on,
    EVERY_FOURTH,
    answering,
  );
  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  unreadable(true);
  const result = await $.prompt.submit(submitted("question 3"));

  expect(result).toMatchObject({ text: "question 3" });
  expect(contextOf(result)).toContain(CONTEXT);
  expect(runsOf(runs, "retrieve")).toHaveLength(3);
  // Turn 3 is no anchor turn: nothing moved the cadence.
  expect(anchorNths(runs)).toEqual([]);
  const said = statuses.filter((s) => s !== undefined && MIMIR_STATUS.test(s));
  expect(said).toHaveLength(1);
  expect(said).not.toContain("mimir: prompt hook failed");

  // The unread prompt was still counted: the next prompt is turn 4, an anchor.
  unreadable(false);
  say([...seen, ...exchange(3)]);
  await $.prompt.submit(submitted("question 4"));

  expect(anchorNths(runs)).toEqual(["0"]);
});
