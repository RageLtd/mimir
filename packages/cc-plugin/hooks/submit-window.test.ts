/**
 * A replaced conversation window, seen from `prompt.submit` alone: when the
 * messages a prompt sees no longer continue the window the previous prompt
 * saw — a compaction or `/clear` replaced or shrank it — that prompt is a
 * reset whether or not lifecycle's `reanchor` flag is set. A reset tells
 * retrieval (`window_reset`), is an anchor turn whose cadence restarts from
 * it, and sends the boot block again.
 */

import { expect, test } from "claude-code/testing";
import {
  anchorNths,
  BOOT,
  CONTEXT,
  CWD,
  compacted,
  converse,
  ending,
  exchange,
  exited,
  RETRIEVED_STATUS,
  retrieved,
  runsOf,
  SESSION,
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

/** The ids a `/clear` leaves the process under, first and second. */
const CLEARED = "session-cleared";
const CLEARED_AGAIN = "session-cleared-again";

test("a compaction that replaced the window makes the next prompt a reset, with no reanchor flag set", async ($, on) => {
  const { say, runs, state } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  // The compaction replaced the two messages prompt 2 saw with two others.
  say(compacted);
  const result = await $.prompt.submit(submitted("where were we?"));

  expect(state.get("reanchor")).not.toBe(true);
  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, true]);
  expect(result).toMatchObject({ text: "where were we?" });
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
  expect(context).toContain(CONTEXT);
  // Turn 3 moved up to the next anchor turn, 4: the first exchange.
  expect(anchorNths(runs)).toEqual(["0"]);
  expect(state.get("turn")).toBe(4);
});

test("after a reset the cadence restarts from it", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);
  say(compacted);
  await $.prompt.submit(submitted("where were we?"));

  // Prompts 4..6 are turns 5..7; prompt 7 is turn 8, the next anchor.
  const after = [...compacted, ...exchange(3)];
  await converse((t) => $.prompt.submit(submitted(t)), say, 4, 6, after);
  expect(anchorNths(runs)).toEqual(["0"]);

  await converse((t) => $.prompt.submit(submitted(t)), say, 7, 7, [
    ...after,
    ...exchange(4),
    ...exchange(5),
    ...exchange(6),
  ]);
  expect(anchorNths(runs)).toEqual(["0", "1"]);
  expect(windowResets(runs)).toEqual([
    false,
    false,
    true,
    false,
    false,
    false,
    false,
  ]);
  expect(runsOf(runs, "boot-context")).toHaveLength(2);
});

test("/clear emptying the window makes the next prompt a reset", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 3);

  say([]);
  const result = await $.prompt.submit(submitted("fresh start"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, false, true]);
  expect(anchorNths(runs)).toEqual(["0"]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
});

test("/clear as the engine raises it, after three exchanges, makes the next prompt a reset", async ($, on) => {
  const { say, runs, switchTo } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 3);

  await $.session.end(ending("clear", SESSION));
  switchTo(CLEARED, CWD);
  say([]);
  const result = await $.prompt.submit(submitted("fresh start"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, false, true]);
  expect(anchorNths(runs)).toEqual(["0"]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
  expect(context).toContain(CONTEXT);
});

test("the boot-context run on a reset carries the session's cwd and id", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  say(compacted);
  await $.prompt.submit(submitted("where were we?"));

  const boots = runsOf(runs, "boot-context");
  expect(boots).toHaveLength(2);
  expect(boots[1]).toEqual(boots[0]);
});

test("ordinary prompts continuing the window run no boot-context and are no reset", async ($, on) => {
  const { say, runs, statuses } = submitSession(on, EVERY_FOURTH, answering);

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 5);

  expect(runsOf(runs, "boot-context")).toHaveLength(1);
  expect(windowResets(runs)).toEqual([false, false, false, false, false]);
  // Turn 4 alone is an anchor turn: no prompt was moved up to one.
  expect(anchorNths(runs)).toEqual(["0"]);
  expect(statuses.filter((s) => s?.startsWith("mimir:"))).toEqual([]);
});

test("an ordinary prompt's context has retrieval's block and no boot block", async ($, on) => {
  const { say } = submitSession(on, EVERY_FOURTH, answering);
  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 1);

  say(seen);
  const result = await $.prompt.submit(submitted("and then?", ["prior"]));

  expect(result).toEqual({ text: "and then?", context: ["prior", CONTEXT] });
});

test("a compaction both flagged and visible in the messages is one reset, and the prompt after it is ordinary", async ($, on) => {
  const { say, runs, state } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  // lifecycle.ts sets the flag on the same compaction that replaced the window.
  state.put("reanchor", true);
  say(compacted);
  await $.prompt.submit(submitted("where were we?"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, true]);
  expect(anchorNths(runs)).toEqual(["0"]);
  expect(state.get("turn")).toBe(4);
  expect(state.get("reanchor")).toBe(false);

  say([...compacted, ...exchange(3)]);
  const result = await $.prompt.submit(submitted("and then?"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, true, false]);
  expect(anchorNths(runs)).toEqual(["0"]);
  expect(state.get("turn")).toBe(5);
  expect(result).toEqual({ text: "and then?", context: [CONTEXT] });
});

test("/clear after a window that held a single exchange makes the next prompt a reset", async ($, on) => {
  const { say, runs, switchTo } = submitSession(on, EVERY_FOURTH, answering);
  // Prompt 1 sees the empty conversation; exchange 1 follows it.
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 1);

  // /clear: the session ends, the process goes on under a new id, and
  // prompt 2 sees an empty window again.
  await $.session.end(ending("clear", SESSION));
  switchTo(CLEARED, CWD);
  say([]);
  const result = await $.prompt.submit(submitted("fresh start"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, true]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
  expect(context).toContain(CONTEXT);
});

test("clearing again after one exchange in a cleared window makes the next prompt a reset too", async ($, on) => {
  const { say, runs, switchTo } = submitSession(on, EVERY_FOURTH, answering);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 1);
  await $.session.end(ending("clear", SESSION));
  switchTo(CLEARED, CWD);
  say([]);
  await $.prompt.submit(submitted("fresh start"));

  // One exchange happens in the cleared window, then /clear again.
  say(exchange(2));
  await $.session.end(ending("clear", CLEARED));
  switchTo(CLEARED_AGAIN, CWD);
  say([]);
  const result = await $.prompt.submit(submitted("fresh start again"));

  expect(runsOf(runs, "boot-context")).toHaveLength(3);
  expect(windowResets(runs)).toEqual([false, true, true]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
  expect(context).toContain(CONTEXT);
});

test("a compaction that keeps the latest messages after its summary, leaving a shorter window, is a reset with no reanchor flag set", async ($, on) => {
  const { say, runs, state } = submitSession(on, EVERY_FOURTH, answering);
  // Prompt 6 sees exchanges 1..5: ten messages.
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 6);

  // Six messages, still ending in the last message prompt 6 saw.
  say([...compacted, ...exchange(5), ...exchange(6)]);
  const result = await $.prompt.submit(submitted("where were we?"));

  expect(state.get("reanchor")).not.toBe(true);
  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
  expect(context).toContain(CONTEXT);
  // Turn 7 moved up to the next anchor turn, 8: the second exchange.
  expect(anchorNths(runs)).toEqual(["0", "1"]);
  expect(state.get("turn")).toBe(8);
});

/**
 * The most messages `$.session.messages` returns: the engine hands back only
 * the newest 4096, so a longer conversation's window slides at this length.
 */
const ENGINE_MESSAGE_CAP = 4096;

test("a window sliding at the engine's message cap is no reset", async ($, on) => {
  const { say, runs } = submitSession(on, EVERY_FOURTH, answering);
  const exchanges = ENGINE_MESSAGE_CAP / 2;
  const full = Array.from({ length: exchanges }, (_, i) =>
    exchange(i + 1),
  ).flat();
  expect(full).toHaveLength(ENGINE_MESSAGE_CAP);

  say(full);
  await $.prompt.submit(submitted(`question ${exchanges + 1}`));

  // The oldest exchange fell off as the newest was appended: same length,
  // every remaining message moved down by two.
  const slid = [...full.slice(2), ...exchange(exchanges + 1)];
  expect(slid).toHaveLength(ENGINE_MESSAGE_CAP);
  say(slid);
  const result = await $.prompt.submit(submitted(`question ${exchanges + 2}`));

  expect(runsOf(runs, "boot-context")).toHaveLength(1);
  expect(windowResets(runs)).toEqual([false, false]);
  expect(result).toEqual({
    text: `question ${exchanges + 2}`,
    context: [CONTEXT],
  });
});

test("a reset signalled by the reanchor flag alone sends the boot block again", async ($, on) => {
  const { say, runs, state } = submitSession(on, EVERY_FOURTH, answering);
  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  // The flag is set; the window has only grown by exchange 2 as usual.
  state.put("reanchor", true);
  say(seen);
  const result = await $.prompt.submit(submitted("where were we?"));

  expect(runsOf(runs, "boot-context")).toHaveLength(2);
  expect(windowResets(runs)).toEqual([false, false, true]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toContain(BOOT);
  expect(context).toContain(CONTEXT);
});
