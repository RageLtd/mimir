/**
 * Precompact and the session journal: the binary summarises the journal's
 * uncovered messages, so the hook sends no `window`, only the undistilled
 * tail for the journal to take in. Per-turn persist keeps that tail
 * near-empty, so an empty tail on a non-empty conversation still runs —
 * the binary decides from the journal whether a summary is owed.
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

test("an empty tail on a non-empty conversation still runs precompact, with messages [] and no window", async ($, on) => {
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
  expect(parsed(precompacts[0]?.payload)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    trigger: "auto",
    messages: [],
    host_completions: true,
  });
  expect(result).toMatchObject({ messages: remaining });
  expect(anchor.get()).toEqual(anchorOf(remaining));
});

test("the tail is slimmed: media blocks never reach the binary, and no window is sent", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const pictured: Message = {
    role: "user",
    content: [
      { type: "text", text: "and then?" },
      { type: "image", source: { data: "…" } },
    ],
  };
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, pictured, ...turnTwo.slice(1)]);
  const runs = binary(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  const [run] = runsOf(runs, "precompact");
  const payload = parsed(run?.payload);
  expect(payload.messages).toEqual(turnTwo);
  expect("window" in payload).toBe(false);
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
 * summarise a conversation its settled run already summarised.
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

test("a skipped compaction whose run settled is not run again when repeated unchanged", async ($, on) => {
  const { clock, runs } = skipping(on, () => exited(0, ADVANCED));

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(1);
  const payload = parsed(precompacts[0]?.payload);
  expect(payload.messages).toEqual(turnTwo);
  expect("window" in payload).toBe(false);
});

test("after a settled skipped compaction, a grown conversation sends only the new turn", async ($, on) => {
  const { clock, grow, runs } = skipping(on, () => exited(0, ADVANCED));

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  grow([...whole, ...turnThree]);
  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(2);
  const second = parsed(precompacts[1]?.payload);
  expect(second.messages).toEqual(turnThree);
  expect("window" in second).toBe(false);
});

const UNSETTLED = [
  [
    "answers advance: false",
    () => exited(0, JSON.stringify({ advance: false })),
  ],
  ["exits non-zero", () => exited(1)],
] as const;

for (const [how, answer] of UNSETTLED) {
  test(`a skipped compaction whose run ${how} sends the same tail again`, async ($, on) => {
    const { clock, runs } = skipping(on, answer);

    await $.session.compact({ trigger: "auto", messages: rows });
    await clock.advance(0);
    await $.session.compact({ trigger: "auto", messages: rows });
    await clock.advance(0);

    const precompacts = runsOf(runs, "precompact");
    expect(precompacts).toHaveLength(2);
    const second = parsed(precompacts[1]?.payload);
    expect(second.messages).toEqual(turnTwo);
    expect("window" in second).toBe(false);
  });
}

test("after a real compaction, the next run's tail is what followed the compacted conversation", async ($, on) => {
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
  const second = parsed(precompacts[1]?.payload);
  expect(second.messages).toEqual(turnThree);
  expect("window" in second).toBe(false);
});
