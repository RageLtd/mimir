/**
 * Session start, from the session's first prompt. `classic.SessionStart` is
 * passed over plugins a person installs where an organization manages
 * Claude Code, so the binary pin and `mimir-cc session-start` both start
 * from the first `prompt.submit` instead, off the prompt, in a dispatch of
 * their own. The binary pin runs once per process; `session-start` runs
 * again on the first prompt after an in-process resume.
 */

import { expect, mock, test } from "claude-code/testing";
import {
  BIN,
  CONTEXT,
  CWD,
  compacted,
  converse,
  ending,
  exchange,
  exited,
  PLUGIN_VERSION,
  parsed,
  RETRIEVED_STATUS,
  retrieved,
  runsOf,
  SESSION,
  submitSession,
  submitted,
} from "./__tests__/submit-fixtures";
import { binary, session } from "./support.test-helpers";

const ENSURE_BINARY = "/scripts/ensure-binary.sh";
const SESSION_START = "session-start";
const SESSION_START_FAILED = /^mimir: session start failed/;

type Runs = Parameters<typeof runsOf>[0];
const pins = (runs: Runs) =>
  runs.filter((run) => run.argv[1]?.endsWith(ENSURE_BINARY));
const starts = (runs: Runs) => runsOf(runs, SESSION_START);

const answering = (sub: string) =>
  sub === "retrieve"
    ? exited(0, retrieved(CONTEXT, RETRIEVED_STATUS))
    : exited(0);

const contextOf = (result: object) =>
  "context" in result ? result.context : undefined;

test("the first prompt starts session-start with its session and cwd, no source", async ($, on) => {
  const { runs, clock, statuses } = submitSession(on, {}, answering);

  await $.prompt.submit(submitted("hello"));
  await clock.advance(0);

  const [run, ...more] = starts(runs);
  expect(more).toEqual([]);
  expect(run?.argv).toEqual([BIN, SESSION_START]);
  expect(run?.env).toEqual({ MIMIR_ACTIVE: "1" });
  const payload = parsed(run?.payload);
  expect(payload).toEqual({ session_id: SESSION, cwd: CWD });
  expect("source" in payload).toBe(false);
  expect(statuses).not.toContainEqual(
    expect.stringMatching(SESSION_START_FAILED),
  );
});

test("the first prompt asks for the binary of the plugin's own version, once", async ($, on) => {
  const { runs, clock, manifests, statuses } = submitSession(on, {}, answering);

  await $.prompt.submit(submitted("hello"));
  await clock.advance(0);

  expect(manifests).toHaveLength(1);
  expect(manifests[0]?.endsWith("/.claude-plugin/plugin.json")).toBe(true);
  const [pin, ...more] = pins(runs);
  expect(more).toEqual([]);
  expect(pin?.argv[0]).toBe("/bin/sh");
  expect(pin?.argv.slice(2)).toEqual(["cc", PLUGIN_VERSION]);
  expect(statuses).toEqual([RETRIEVED_STATUS]);
});

test("neither holds the prompt: its result and retrieval come first, both run once the clock moves", async ($, on) => {
  const { runs, clock } = submitSession(on, {}, answering);

  const result = await $.prompt.submit(submitted("hello"));

  expect(result).toMatchObject({ text: "hello" });
  expect(contextOf(result)).toContain(CONTEXT);
  expect(runsOf(runs, "retrieve")).toHaveLength(1);
  expect(starts(runs)).toEqual([]);
  expect(pins(runs)).toEqual([]);

  await clock.advance(0);

  expect(starts(runs)).toHaveLength(1);
  expect(pins(runs)).toHaveLength(1);
  const order = runs.map((run) => run.argv[1]);
  expect(order.indexOf("retrieve")).toBeLessThan(order.indexOf(SESSION_START));
});

test("a second, ordinary prompt starts neither again", async ($, on) => {
  const { runs, clock, say } = submitSession(on, {}, answering);

  await converse(
    async (t) => {
      await $.prompt.submit(submitted(t));
      await clock.advance(0);
    },
    say,
    1,
    2,
  );

  expect(runsOf(runs, "retrieve")).toHaveLength(2);
  expect(starts(runs)).toHaveLength(1);
  expect(pins(runs)).toHaveLength(1);
});

test("a prompt after a replaced window starts neither again", async ($, on) => {
  const { runs, clock, say } = submitSession(on, {}, answering);
  const submit = async (t: string) => {
    await $.prompt.submit(submitted(t));
    await clock.advance(0);
  };
  await converse(submit, say, 1, 2);

  say(compacted);
  await submit("where were we?");

  // The reset itself is seen: retrieval is told and the boot block resent.
  expect(
    runsOf(runs, "retrieve").map((r) => parsed(r.payload).window_reset),
  ).toEqual([false, false, true]);
  expect(starts(runs)).toHaveLength(1);
  expect(pins(runs)).toHaveLength(1);
});

test("a prompt after the reanchor flag starts neither again", async ($, on) => {
  const { runs, clock, say, state } = submitSession(on, {}, answering);
  const submit = async (t: string) => {
    await $.prompt.submit(submitted(t));
    await clock.advance(0);
  };
  const seen = await converse(submit, say, 1, 1);

  state.put("reanchor", true);
  say(seen);
  await submit("question 2");

  expect(
    runsOf(runs, "retrieve").map((r) => parsed(r.payload).window_reset),
  ).toEqual([false, true]);
  expect(starts(runs)).toHaveLength(1);
  expect(pins(runs)).toHaveLength(1);
});

// The same process, and so the same `$.state`, going on under another
// session: after a resume (possibly in another directory, with that
// session's messages) or after a `/clear` (a new id, an empty window).
const RESUMED = "session-resumed";
const RESUMED_CWD = "/work/elsewhere";
const CLEARED = "session-cleared";
const resumedWindow = [...exchange(7), ...exchange(8)];

const switching = (
  on: Parameters<typeof submitSession>[0],
  send: (prompt: ReturnType<typeof submitted>) => Promise<unknown>,
  end: (e: ReturnType<typeof ending>) => Promise<unknown>,
) => {
  const fixture = submitSession(on, {}, answering);
  const submit = async (t: string) => {
    await send(submitted(t));
    await fixture.clock.advance(0);
  };
  const resumeTo = async (from: string, id: string, cwd: string) => {
    await end(ending("resume", from));
    fixture.switchTo(id, cwd);
    fixture.say(resumedWindow);
  };
  const clear = async (from: string, id: string) => {
    await end(ending("clear", from));
    fixture.switchTo(id, CWD);
    fixture.say([]);
  };
  return { ...fixture, submit, resumeTo, clear };
};

test("the first prompt after a resume starts session-start again, with the resumed session's id and cwd", async ($, on) => {
  const { runs, submit, resumeTo } = switching(
    on,
    (e) => $.prompt.submit(e),
    (e) => $.session.end(e),
  );

  await submit("hello");
  await resumeTo(SESSION, RESUMED, RESUMED_CWD);
  await submit("back again");

  const payloads = starts(runs).map((run) => parsed(run.payload));
  expect(payloads).toEqual([
    { session_id: SESSION, cwd: CWD },
    { session_id: RESUMED, cwd: RESUMED_CWD },
  ]);
});

test("further prompts in the resumed session start no third session-start", async ($, on) => {
  const { runs, submit, resumeTo, say } = switching(
    on,
    (e) => $.prompt.submit(e),
    (e) => $.session.end(e),
  );

  await submit("hello");
  await resumeTo(SESSION, RESUMED, RESUMED_CWD);
  await converse(submit, say, 9, 11, resumedWindow);

  expect(starts(runs)).toHaveLength(2);
});

test("resuming back to the first session is another resume and starts session-start for it", async ($, on) => {
  const { runs, submit, resumeTo } = switching(
    on,
    (e) => $.prompt.submit(e),
    (e) => $.session.end(e),
  );

  await submit("hello");
  await resumeTo(SESSION, RESUMED, RESUMED_CWD);
  await submit("back again");
  await resumeTo(RESUMED, SESSION, CWD);
  await submit("home again");

  const payloads = starts(runs).map((run) => parsed(run.payload));
  expect(payloads).toEqual([
    { session_id: SESSION, cwd: CWD },
    { session_id: RESUMED, cwd: RESUMED_CWD },
    { session_id: SESSION, cwd: CWD },
  ]);
});

test("a prompt after /clear starts no session-start and pins nothing again", async ($, on) => {
  const { runs, submit, clear } = switching(
    on,
    (e) => $.prompt.submit(e),
    (e) => $.session.end(e),
  );

  await submit("hello");
  await clear(SESSION, CLEARED);
  await submit("fresh start");

  expect(starts(runs)).toHaveLength(1);
  expect(pins(runs)).toHaveLength(1);
});

test("a resume does not pin the binary again", async ($, on) => {
  const { runs, submit, resumeTo } = switching(
    on,
    (e) => $.prompt.submit(e),
    (e) => $.session.end(e),
  );

  await submit("hello");
  await resumeTo(SESSION, RESUMED, RESUMED_CWD);
  await submit("back again");

  expect(starts(runs)).toHaveLength(2);
  expect(pins(runs)).toHaveLength(1);
});

test("a session-start run that exits non-zero shows a status line and costs the prompt nothing", async ($, on) => {
  const { runs, clock, statuses } = submitSession(on, {}, (sub) =>
    sub === SESSION_START ? exited(3) : answering(sub),
  );

  const result = await $.prompt.submit(submitted("hello"));
  await clock.advance(0);

  expect(starts(runs)).toHaveLength(1);
  expect(result).toMatchObject({ text: "hello" });
  expect(contextOf(result)).toContain(CONTEXT);
  expect(statuses).toContain(RETRIEVED_STATUS);
  const failed = statuses.filter(
    (s) => s !== undefined && SESSION_START_FAILED.test(s),
  );
  expect(failed).toEqual(["mimir: session start failed (exit 3)"]);
});

test("a session-start run that cannot be run shows a status line and costs the prompt nothing", async ($, on) => {
  const { clock, statuses } = submitSession(on, {}, (sub) => {
    if (sub === SESSION_START) throw new Error("ENOENT");
    return answering(sub);
  });

  const result = await $.prompt.submit(submitted("hello"));
  await clock.advance(0);

  expect(result).toMatchObject({ text: "hello" });
  expect(contextOf(result)).toContain(CONTEXT);
  expect(statuses).toContain(RETRIEVED_STATUS);
  expect(statuses).not.toContain("mimir: prompt hook failed");
  const failed = statuses.filter(
    (s) => s !== undefined && SESSION_START_FAILED.test(s),
  );
  expect(failed).toHaveLength(1);
});

test("a fetch that fails shows its status line and costs the prompt nothing", async ($, on) => {
  const { runs, clock, statuses } = submitSession(on, {}, (sub) =>
    sub.endsWith(ENSURE_BINARY) ? exited(1) : answering(sub),
  );

  const result = await $.prompt.submit(submitted("hello"));
  await clock.advance(0);

  expect(result).toMatchObject({ text: "hello" });
  expect(contextOf(result)).toContain(CONTEXT);
  expect(starts(runs)).toHaveLength(1);
  expect(statuses).toEqual([
    RETRIEVED_STATUS,
    `mimir: could not fetch the mimir-cc ${PLUGIN_VERSION} binary (exit 1)`,
  ]);
});

test("a manifest without a version fetches nothing, says so, and costs the prompt nothing", async ($, on) => {
  const { runs, clock, statuses } = submitSession(
    on,
    {},
    answering,
    "latest; rm -rf",
  );

  const result = await $.prompt.submit(submitted("hello"));
  await clock.advance(0);

  expect(result).toMatchObject({ text: "hello" });
  expect(contextOf(result)).toContain(CONTEXT);
  expect(pins(runs)).toEqual([]);
  expect(starts(runs)).toHaveLength(1);
  expect(statuses).toContain("mimir: plugin.json carries no version");
  expect(statuses).toContain(RETRIEVED_STATUS);
});

test("classic.SessionStart runs no binary and shows no status line", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const runs = binary(on);
  on("fs.read", () => ({ value: JSON.stringify({ version: PLUGIN_VERSION }) }));
  on("classic.SessionStart", () => ({}));

  await $.classic.SessionStart({ source: "startup", cwd: CWD });
  await clock.advance(0);

  expect(runs).toEqual([]);
  expect(statuses).toEqual([]);
});
