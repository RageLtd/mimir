import { expect, test } from "claude-code/testing";
import {
  ANCHOR,
  BIN,
  CONTEXT,
  CWD,
  converse,
  exited,
  parsed,
  RETRIEVED_STATUS,
  retrieved,
  runsOf,
  SESSION,
  submitSession,
  submitted,
} from "./__tests__/submit-fixtures";
import { anchorIndexFor, anchorInterval, nextAnchorTurn } from "./submit";

test("counts the turn and runs retrieve with the UserPromptSubmit payload, attaching its context", async ($, on) => {
  const { state, statuses, runs } = submitSession(on, {}, (sub) =>
    sub === "retrieve"
      ? exited(0, retrieved(CONTEXT, RETRIEVED_STATUS))
      : exited(0),
  );

  const result = await $.prompt.submit(submitted("what do we know?"));

  expect(state.get("turn")).toBe(1);
  expect(
    runsOf(runs, "retrieve").map((run) => ({
      ...run,
      payload: parsed(run.payload),
    })),
  ).toEqual([
    {
      argv: [BIN, "retrieve"],
      payload: {
        session_id: SESSION,
        hook_event_name: "UserPromptSubmit",
        prompt: "what do we know?",
        cwd: CWD,
        window_reset: false,
        session_start: true,
      },
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(result).toEqual({ text: "what do we know?", context: [CONTEXT] });
  expect(statuses).toEqual([RETRIEVED_STATUS]);
});

test("retrieval is told the session's first prompt, and only that one", async ($, on) => {
  const { say, runs } = submitSession(on);

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  expect(
    runsOf(runs, "retrieve").map((run) => parsed(run.payload)),
  ).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: false },
  ]);
});

const PENDING_STATUS = "↻ Last session's summary is still generating";
const pending = () =>
  JSON.stringify({ summaryPending: true, systemMessage: PENDING_STATUS });

/** Retrieve's answer per run, in order; every other run exits 0, silent. */
const scripted = (replies: Array<() => ReturnType<typeof exited>>) => {
  let n = 0;
  return (sub: string) => {
    if (sub !== "retrieve") return exited(0);
    const reply = replies[n];
    n += 1;
    return reply ? reply() : exited(0);
  };
};

const retrievePayloads = (runs: Parameters<typeof runsOf>[0]) =>
  runsOf(runs, "retrieve").map((run) => parsed(run.payload));

test("a summary still generating stays owed: the next prompt asks for it again, and says so on the status line", async ($, on) => {
  const { say, statuses, runs } = submitSession(
    on,
    {},
    scripted([() => exited(0, pending())]),
  );

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  expect(retrievePayloads(runs)).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: true },
  ]);
  expect(statuses).toContain(PENDING_STATUS);
});

test("once retrieval answers without a pending summary, it is asked for no more", async ($, on) => {
  const { say, runs } = submitSession(
    on,
    {},
    scripted([
      () => exited(0, pending()),
      () => exited(0, retrieved(CONTEXT, RETRIEVED_STATUS)),
    ]),
  );

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 3);

  expect(retrievePayloads(runs)).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: true },
    { prompt: "question 3", session_start: false },
  ]);
});

test("a first prompt whose retrieve exits non-zero leaves the summary owed", async ($, on) => {
  const { say, runs } = submitSession(on, {}, scripted([() => exited(2)]));

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  expect(retrievePayloads(runs)).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: true },
  ]);
});

test("a first prompt whose retrieve cannot run leaves the summary owed", async ($, on) => {
  const { say, runs } = submitSession(
    on,
    {},
    scripted([
      () => {
        throw new Error("ENOENT");
      },
    ]),
  );

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  expect(retrievePayloads(runs)).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: true },
  ]);
});

test("a first prompt whose retrieve prints text that is not JSON fails that leg and leaves the summary owed", async ($, on) => {
  const { say, statuses, runs } = submitSession(
    on,
    {},
    scripted([() => exited(0, "not json at all")]),
  );

  say([]);
  const result = await $.prompt.submit(submitted("question 1"));

  expect(result).toEqual({ text: "question 1" });
  expect(statuses.filter((s) => s?.startsWith("mimir:"))).toHaveLength(1);

  await converse((t) => $.prompt.submit(submitted(t)), say, 2, 2);

  expect(retrievePayloads(runs)).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: true },
  ]);
});

test("a first prompt whose retrieve failed inside and printed only summaryPending stays owed, quietly", async ($, on) => {
  const { say, statuses, runs } = submitSession(
    on,
    {},
    scripted([() => exited(0, JSON.stringify({ summaryPending: true }))]),
  );

  say([]);
  const result = await $.prompt.submit(submitted("question 1"));

  expect(result).toEqual({ text: "question 1" });
  expect(statuses).toEqual([]);

  await converse((t) => $.prompt.submit(submitted(t)), say, 2, 2);

  expect(retrievePayloads(runs)).toMatchObject([
    { prompt: "question 1", session_start: true },
    { prompt: "question 2", session_start: true },
  ]);
});

test("every third turn also runs voice-anchor for the next exchange in the rotation", async ($, on) => {
  const { state, say, runs } = submitSession(on, {}, (sub) =>
    sub === "voice-anchor"
      ? exited(0, `${ANCHOR}\n`)
      : sub === "retrieve"
        ? exited(0, retrieved(CONTEXT, RETRIEVED_STATUS))
        : exited(0),
  );

  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);
  say(seen);
  const result = await $.prompt.submit(submitted("still there?", ["prior"]));

  expect(state.get("turn")).toBe(3);
  expect(runsOf(runs, "voice-anchor")).toEqual([
    {
      argv: [BIN, "voice-anchor", "--session", SESSION, "--nth", "0"],
      payload: undefined,
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(result).toEqual({
    text: "still there?",
    context: ["prior", CONTEXT, ANCHOR],
  });
});

test("MIMIR_ANCHOR_INTERVAL sets the cadence", async ($, on) => {
  const { say, runs } = submitSession(on, { MIMIR_ANCHOR_INTERVAL: "2" });

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 4);

  expect(runsOf(runs, "voice-anchor").map((run) => run.argv)).toEqual([
    [BIN, "voice-anchor", "--session", SESSION, "--nth", "0"],
    [BIN, "voice-anchor", "--session", SESSION, "--nth", "1"],
  ]);
});

test("the first prompt after a compaction is anchored whatever the count, and the cadence restarts from it", async ($, on) => {
  const { state, say, runs } = submitSession(on);

  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 6);
  // The compaction's flag, the conversation the prompt sees unchanged.
  state.put("reanchor", true);
  say(seen);
  await $.prompt.submit(submitted("where were we?"));

  // Retrieval is told the window was replaced, so it may send again what
  // it sent before the compaction.
  expect(retrievePayloads(runs).at(-1)).toMatchObject({
    prompt: "where were we?",
    window_reset: true,
  });

  // Turn 7 becomes the next anchor turn, 9: the third exchange in the
  // rotation, after turns 3 and 6 took the first two.
  expect(runsOf(runs, "voice-anchor").map((run) => run.argv.at(-1))).toEqual([
    "0",
    "1",
    "2",
  ]);
  expect(state.get("turn")).toBe(9);
  expect(state.get("reanchor")).toBe(false);
});

test("passes the prompt through untouched when neither leg has anything to add", async ($, on) => {
  const { say } = submitSession(on);

  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 1);
  say(seen);
  const result = await $.prompt.submit(submitted("hello", ["prior"]));

  expect(result).toEqual({ text: "hello", context: ["prior"] });
});

test("a failing leg costs only itself", async ($, on) => {
  const { say, statuses, answer } = submitSession(on);

  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);
  answer((sub) => (sub === "retrieve" ? exited(2) : exited(0, ANCHOR)));
  statuses.length = 0;
  say(seen);
  const result = await $.prompt.submit(submitted("hello"));

  expect(result).toEqual({ text: "hello", context: [ANCHOR] });
  expect(statuses).toEqual(["mimir: retrieve failed (exit 2)"]);
});

test("fails open, counter advanced, when the binary cannot be run at all", async ($, on) => {
  const { state, say, statuses, answer } = submitSession(on);

  const seen = await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);
  answer(() => {
    throw new Error("ENOENT");
  });
  statuses.length = 0;
  say(seen);
  const result = await $.prompt.submit(submitted("hello"));

  expect(state.get("turn")).toBe(3);
  expect(result).toEqual({ text: "hello" });
  expect(statuses).toEqual([
    "mimir: retrieve failed",
    "mimir: voice anchor failed",
  ]);
});

test("cadence helpers", async () => {
  expect(anchorInterval(undefined)).toBe(3);
  expect(anchorInterval("5")).toBe(5);
  expect(anchorInterval("0")).toBe(3);
  expect(anchorInterval("nope")).toBe(3);
  expect([1, 4, 5, 9, 10, 15].map((t) => anchorIndexFor(t, 5))).toEqual([
    null,
    null,
    0,
    null,
    1,
    2,
  ]);
  expect([1, 5, 6, 10].map((t) => nextAnchorTurn(t, 5))).toEqual([
    5, 5, 10, 10,
  ]);
});
