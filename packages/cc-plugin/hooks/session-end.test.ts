/**
 * The session's end summary: `session.end` hands the whole conversation to
 * `mimir-cc session-end`, which detaches the summarising worker and
 * returns. The whole chain shares one short bound, so the run is short and
 * no model call runs here; a failure never holds the event.
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

test("a session's end hands session-end the whole conversation, and the event passes on", async ($, on) => {
  const statuses = session(on);
  mock.clock(on);
  summarisedState(on);
  conversation(on, whole);
  const { seen } = runs(on);
  core(on);

  const result = await $.session.end(ending("prompt_input_exit"));

  const ended = runsOf(seen, SESSION_END);
  expect(ended).toHaveLength(1);
  expect(ended[0]?.argv).toEqual([BIN, SESSION_END]);
  expect(ended[0]?.env).toEqual({ MIMIR_ACTIVE: "1" });
  expect(parsed(ended[0]?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    reason: "prompt_input_exit",
    window: whole,
  });
  expect(result).toEqual({ sessionId: SESSION });
  expect(statuses).toEqual([]);
});

test("the window is slimmed: media blocks never cross stdin", async ($, on) => {
  session(on);
  mock.clock(on);
  summarisedState(on);
  const pictured: Message = {
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image", source: { data: "…" } },
    ],
  };
  conversation(on, [pictured, ...turnOne.slice(1), ...turnTwo]);
  const { seen } = runs(on);
  core(on);

  await $.session.end(ending());

  const [run] = runsOf(seen, SESSION_END);
  expect(parsed(run?.stdin).window).toEqual(whole);
});

test("every reason runs session-end, a /clear included", async ($, on) => {
  session(on);
  mock.clock(on);
  summarisedState(on);
  conversation(on, whole);
  const { seen } = runs(on);
  core(on);

  for (const reason of REASONS) await $.session.end(ending(reason));

  const ended = runsOf(seen, SESSION_END);
  expect(ended.map((run) => parsed(run.stdin).reason)).toEqual([...REASONS]);
});

test("the run sits inside the session end's short bound", async ($, on) => {
  session(on);
  mock.clock(on);
  summarisedState(on);
  conversation(on, whole);
  const { seen, timeouts } = runs(on);
  core(on);

  await $.session.end(ending());

  const index = seen.findIndex((run) => run.argv[1] === SESSION_END);
  expect(index).toBeGreaterThanOrEqual(0);
  const timeoutMs = timeouts[index];
  expect(timeoutMs).toBeDefined();
  expect(timeoutMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1_000);
});

test("an empty conversation runs nothing", async ($, on) => {
  const statuses = session(on);
  mock.clock(on);
  summarisedState(on);
  conversation(on, []);
  const { seen } = runs(on);
  core(on);

  const result = await $.session.end(ending());

  expect(runsOf(seen, SESSION_END)).toEqual([]);
  expect(result).toEqual({ sessionId: SESSION });
  expect(statuses).toEqual([]);
});

test("a conversation already summarised runs nothing; a turn past it runs", async ($, on) => {
  session(on);
  mock.clock(on);
  summarisedState(on, anchorOf(whole));
  const grow = conversation(on, whole);
  const { seen } = runs(on);
  core(on);

  await $.session.end(ending());
  expect(runsOf(seen, SESSION_END)).toEqual([]);

  const grown = [...whole, ...turnOne];
  grow(grown);
  await $.session.end(ending());

  const ended = runsOf(seen, SESSION_END);
  expect(ended).toHaveLength(1);
  expect(parsed(ended[0]?.stdin).window).toEqual(grown);
});

/**
 * A real compaction leaves the conversation as its compacted messages; the
 * compaction's own precompact run summarises the window it replaced, so an
 * end with nothing said since must not summarise again — settled or not.
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

test("after a real compaction and a new turn, the end runs with the grown window", async ($, on) => {
  const { clock, grow, seen } = compacting(on);

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);
  const grown = [...compactedTurns, ...turnThree];
  grow(grown);
  await $.session.end(ending());

  const ended = runsOf(seen, SESSION_END);
  expect(ended).toHaveLength(1);
  expect(parsed(ended[0]?.stdin).window).toEqual(grown);
});

test("a run that exits non-zero shows one status line and the event passes on", async ($, on) => {
  const statuses = session(on);
  mock.clock(on);
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
