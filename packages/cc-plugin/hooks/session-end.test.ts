/**
 * The session's end summary: `session.end` hands `mimir-cc session-end` the
 * undistilled tail — the delta a persist run would send — for the session
 * journal, and the binary summarises from the journal, so no `window` is
 * sent. It detaches the summarising worker and returns. The whole chain
 * shares one short bound, so the run is short and no model call runs here;
 * a failure never holds the event.
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
  CWD,
  exited,
  type Run,
  runsOf,
  SESSION,
  session,
} from "./support.test-helpers";

const SESSION_END = "session-end";
const REASONS = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "other",
] as const;
const whole = [...turnOne, ...turnTwo];

const ending = (reason: (typeof REASONS)[number] = "prompt_input_exit") => ({
  reason,
  sessionId: SESSION,
  resume: { id: SESSION },
});

/** Every binary run with its timeout; `answer` picks the result. */
const runs = (
  on: On,
  answer: () => ReturnType<typeof exited> = () => exited(0),
) => {
  const seen: Run[] = [];
  const timeouts: Array<number | undefined> = [];
  on("process.run", (_, e) => {
    seen.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    timeouts.push(e.init?.timeoutMs);
    return answer();
  });
  return { seen, timeouts };
};

const core = (on: On) =>
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));

/** A session distilled through turn one, saying `messages`. */
const ended = (on: On, messages: readonly Message[] = whole) => {
  const statuses = session(on);
  mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  summarisedState(on);
  const grow = conversation(on, messages);
  const { seen, timeouts } = runs(on);
  core(on);
  return { statuses, grow, seen, timeouts };
};

test("a session's end hands session-end the undistilled tail and no window, and the event passes on", async ($, on) => {
  const { statuses, seen } = ended(on);

  const result = await $.session.end(ending("prompt_input_exit"));

  const runsEnded = runsOf(seen, SESSION_END);
  expect(runsEnded).toHaveLength(1);
  expect(runsEnded[0]?.argv).toEqual([BIN, SESSION_END]);
  expect(runsEnded[0]?.env).toEqual({ MIMIR_ACTIVE: "1" });
  expect(parsed(runsEnded[0]?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    reason: "prompt_input_exit",
    messages: turnTwo,
  });
  expect(result).toEqual({ sessionId: SESSION });
  expect(statuses).toEqual([]);
});

test("the tail is slimmed like a persist delta: media blocks never cross stdin", async ($, on) => {
  const pictured: Message = {
    role: "user",
    content: [
      { type: "text", text: "and then?" },
      { type: "image", source: { data: "…" } },
    ],
  };
  const { seen } = ended(on, [...turnOne, pictured, ...turnTwo.slice(1)]);

  await $.session.end(ending());

  const [run] = runsOf(seen, SESSION_END);
  const payload = parsed(run?.stdin);
  expect(payload.messages).toEqual(turnTwo);
  expect("window" in payload).toBe(false);
});

test("with everything distilled the run is still made, with messages []", async ($, on) => {
  session(on);
  mock.clock(on);
  anchorState(on, anchorOf(whole));
  summarisedState(on);
  conversation(on, whole);
  const { seen } = runs(on);
  core(on);

  await $.session.end(ending());

  const runsEnded = runsOf(seen, SESSION_END);
  expect(runsEnded).toHaveLength(1);
  expect(parsed(runsEnded[0]?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    reason: "prompt_input_exit",
    messages: [],
  });
});

test("with nothing distilled yet the whole conversation is the tail", async ($, on) => {
  session(on);
  mock.clock(on);
  anchorState(on);
  summarisedState(on);
  conversation(on, whole);
  const { seen } = runs(on);
  core(on);

  await $.session.end(ending());

  const [run] = runsOf(seen, SESSION_END);
  expect(parsed(run?.stdin).messages).toEqual(whole);
});

test("every reason runs session-end, a /clear included", async ($, on) => {
  const { seen } = ended(on);

  for (const reason of REASONS) await $.session.end(ending(reason));

  const runsEnded = runsOf(seen, SESSION_END);
  expect(runsEnded.map((run) => parsed(run.stdin).reason)).toEqual([
    ...REASONS,
  ]);
});

test("the run sits inside the session end's short bound", async ($, on) => {
  const { seen, timeouts } = ended(on);

  await $.session.end(ending());

  const index = seen.findIndex((run) => run.argv[1] === SESSION_END);
  expect(index).toBeGreaterThanOrEqual(0);
  const timeoutMs = timeouts[index];
  expect(timeoutMs).toBeDefined();
  expect(timeoutMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1_000);
});

test("an empty conversation runs nothing", async ($, on) => {
  const { statuses, seen } = ended(on, []);

  const result = await $.session.end(ending());

  expect(runsOf(seen, SESSION_END)).toEqual([]);
  expect(result).toEqual({ sessionId: SESSION });
  expect(statuses).toEqual([]);
});

test("a conversation already summarised runs nothing; a turn past it runs with that turn", async ($, on) => {
  session(on);
  mock.clock(on);
  anchorState(on, anchorOf(whole));
  summarisedState(on, anchorOf(whole));
  const grow = conversation(on, whole);
  const { seen } = runs(on);
  core(on);

  await $.session.end(ending());
  expect(runsOf(seen, SESSION_END)).toEqual([]);

  grow([...whole, ...turnThree]);
  await $.session.end(ending());

  const runsEnded = runsOf(seen, SESSION_END);
  expect(runsEnded).toHaveLength(1);
  expect(parsed(runsEnded[0]?.stdin).messages).toEqual(turnThree);
});

/**
 * A real compaction leaves the conversation as its compacted messages; the
 * compaction's own precompact run summarises what it replaced, so an end
 * with nothing said since must not summarise again — settled or not.
 */
const ADVANCED = JSON.stringify({ advance: true });

const compacting = (on: On) => {
  session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  summarisedState(on);
  const grow = conversation(on, whole);
  const { seen } = runs(on, () => exited(0, ADVANCED));
  on("session.compact", () => ({ messages: remaining }));
  core(on);
  return { clock, grow, seen };
};

test("after a real compaction whose run settled, an end with nothing said since runs nothing", async ($, on) => {
  const { clock, grow, seen } = compacting(on);

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  expect(runsOf(seen, "precompact")).toHaveLength(1);
  grow(compactedTurns);
  const result = await $.session.end(ending());

  expect(runsOf(seen, SESSION_END)).toEqual([]);
  expect(result).toEqual({ sessionId: SESSION });
});

test("after a real compaction whose run has not settled yet, an end with nothing said since runs nothing", async ($, on) => {
  const { grow, seen } = compacting(on);

  await $.session.compact({ trigger: "auto", messages: rows });
  grow(compactedTurns);
  await $.session.end(ending());

  expect(runsOf(seen, SESSION_END)).toEqual([]);
});

test("after a real compaction and a new turn, the end sends that turn as the tail", async ($, on) => {
  const { clock, grow, seen } = compacting(on);

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  grow([...compactedTurns, ...turnThree]);
  await $.session.end(ending());

  const runsEnded = runsOf(seen, SESSION_END);
  expect(runsEnded).toHaveLength(1);
  const payload = parsed(runsEnded[0]?.stdin);
  expect(payload.messages).toEqual(turnThree);
  expect("window" in payload).toBe(false);
});

test("a run that exits non-zero shows one status line and the event passes on", async ($, on) => {
  const statuses = session(on);
  mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  summarisedState(on);
  conversation(on, whole);
  runs(on, () => exited(3));
  core(on);

  const result = await $.session.end(ending());

  expect(result).toEqual({ sessionId: SESSION });
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.startsWith("mimir:")).toBe(true);
});

test("a run that throws shows one status line and the event passes on", async ($, on) => {
  const statuses = session(on);
  mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  summarisedState(on);
  conversation(on, whole);
  on("process.run", () => {
    throw new Error("ENOENT");
  });
  core(on);

  const result = await $.session.end(ending());

  expect(result).toEqual({ sessionId: SESSION });
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.startsWith("mimir:")).toBe(true);
});
