/**
 * Precompact's whole window: the summary covers the conversation as it
 * stood before compaction, while facts come from the undistilled delta
 * alone. Per-turn persist keeps that delta near-empty, so the window —
 * not the delta — decides whether precompact runs at all.
 */

import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import {
  anchorState,
  compactedTurns,
  conversation,
  parsed,
  pendingState,
  remaining,
  rows,
  summarisedState,
  turnOne,
  turnThree,
  turnTwo,
} from "./__tests__/lifecycle-fixtures";
import { anchorOf, type Message } from "./messages";
import {
  BIN,
  binary,
  CWD,
  exited,
  runsOf,
  SESSION,
  session,
} from "./support.test-helpers";

const ADVANCED = JSON.stringify({ advance: true });
const whole = [...turnOne, ...turnTwo];

test("an empty delta still runs precompact with the whole window to summarise", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(whole));
  pendingState(on);
  conversation(on, whole);
  const runs = binary(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));

  const result = await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(1);
  expect(precompacts[0]?.argv).toEqual([BIN, "precompact"]);
  expect(parsed(precompacts[0]?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    trigger: "auto",
    messages: [],
    window: whole,
    host_completions: true,
  });
  expect(result).toMatchObject({ messages: remaining });
  expect(anchor.get()).toEqual(anchorOf(remaining));
});

test("the window is slimmed like the delta: media blocks never cross stdin", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const pictured: Message = {
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image", source: { data: "…" } },
    ],
  };
  anchorState(on, anchorOf([pictured, ...turnOne.slice(1)]));
  pendingState(on);
  conversation(on, [pictured, ...turnOne.slice(1), ...turnTwo]);
  const runs = binary(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  const [run] = runsOf(runs, "precompact");
  const payload = parsed(run?.stdin);
  expect(payload.messages).toEqual(turnTwo);
  expect(payload.window).toEqual(whole);
});

test("an empty conversation runs no precompact, and the compaction still re-anchors", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on);
  pendingState(on);
  conversation(on, []);
  const runs = binary(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));

  const result = await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  expect(runsOf(runs, "precompact")).toEqual([]);
  expect(result).toMatchObject({ messages: remaining });
  expect(anchor.get()).toEqual(anchorOf(remaining));
});

test("a precompute or a subagent's compaction runs nothing even with a fully distilled window", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(whole));
  pendingState(on);
  conversation(on, whole);
  const runs = binary(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "precompute", messages: rows });
  await $.session.compact({
    trigger: "auto",
    agentId: "agent-1",
    messages: rows,
  });
  await clock.advance(0);

  expect(runs).toEqual([]);
  expect(anchor.get()).toEqual(anchorOf(whole));
});

/**
 * A skipped compaction re-anchors nothing, so a repeat of it must not
 * summarise a window its settled run already summarised: summaries are not
 * vector-deduped, and each repeat would store a near-identical row.
 */
const SKIPPED = { skip: "not now" };

/** A conversation one turn past its last persist, whose compactions skip. */
const skipping = (on: On, answer: () => ReturnType<typeof exited>) => {
  session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  summarisedState(on);
  const grow = conversation(on, whole);
  const runs = binary(on, answer);
  on("session.compact", () => SKIPPED);
  return { clock, grow, runs };
};

test("a skipped compaction whose run settled is not summarised again when repeated unchanged", async ($, on) => {
  const { clock, runs } = skipping(on, () => exited(0, ADVANCED));

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(1);
  expect(parsed(precompacts[0]?.stdin)).toMatchObject({
    messages: turnTwo,
    window: whole,
  });
});

test("after a settled skipped compaction, a grown conversation sends the whole window and only the new turn", async ($, on) => {
  const { clock, grow, runs } = skipping(on, () => exited(0, ADVANCED));

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  grow([...whole, ...turnThree]);
  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(2);
  const second = parsed(precompacts[1]?.stdin);
  expect(second.messages).toEqual(turnThree);
  expect(second.window).toEqual([...whole, ...turnThree]);
});

const UNSETTLED = [
  [
    "answers advance: false",
    () => exited(0, JSON.stringify({ advance: false })),
  ],
  ["exits non-zero", () => exited(1)],
] as const;

for (const [how, answer] of UNSETTLED) {
  test(`a skipped compaction whose run ${how} sends the same window again`, async ($, on) => {
    const { clock, runs } = skipping(on, answer);

    await $.session.compact({ trigger: "auto", messages: rows });
    await clock.advance(0);
    await $.session.compact({ trigger: "auto", messages: rows });
    await clock.advance(0);

    const precompacts = runsOf(runs, "precompact");
    expect(precompacts).toHaveLength(2);
    expect(parsed(precompacts[1]?.stdin)).toMatchObject({
      messages: turnTwo,
      window: whole,
    });
  });
}

test("after a real compaction, the next window is the compacted conversation and what followed", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  summarisedState(on);
  const grow = conversation(on, whole);
  const runs = binary(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  grow([...compactedTurns, ...turnThree]);
  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(2);
  const second = parsed(precompacts[1]?.stdin);
  expect(second.messages).toEqual(turnThree);
  expect(second.window).toEqual([...compactedTurns, ...turnThree]);
});
