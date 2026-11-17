/**
 * The compaction nobody announced: when `prompt.submit` sees from the
 * messages that the window was replaced and no `reanchor` flag was set,
 * no `session.compact` reached this plugin, so no precompact ran. The hook
 * starts one for the session — `messages: []`, no `window`, the binary
 * deciding from the journal — through the same two-phase machinery the
 * lifecycle legs use, detached so the prompt never waits on it.
 */

import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";
import { answered, model, SUMMARY } from "./__tests__/lifecycle-fixtures";
import {
  BIN,
  BOOT,
  CONTEXT,
  CWD,
  compacted,
  converse,
  ending,
  exchange,
  exited,
  parsed,
  RETRIEVED_STATUS,
  retrieved,
  runsOf,
  SESSION,
  submitSession,
  submitted,
  windowResets,
} from "./__tests__/submit-fixtures";

const PRECOMPACT = "precompact";
const ADVANCED = { advance: true };
const ASKS = { requests: { summary: SUMMARY } };
const SUMMARY_TEXT = "They were mid-way through the journal work.";

/** Answers by subcommand; precompact's answers go phase by phase. */
const answering = (precompact: readonly object[] = [ADVANCED]) => {
  let run = 0;
  return (sub: string) => {
    if (sub === "boot-context") return exited(0, `${BOOT}\n`);
    if (sub === "retrieve")
      return exited(0, retrieved(CONTEXT, RETRIEVED_STATUS));
    if (sub !== PRECOMPACT) return exited(0);
    const output = precompact[Math.min(run, precompact.length - 1)] ?? {};
    run += 1;
    return exited(0, JSON.stringify(output));
  };
};

/** The plugin's `$.store`, which a settled leg keeps its anchor in. */
const store = (on: On) => {
  const kept = new Map<string, unknown>();
  on("store.get", (_, e) => ({ value: kept.get(e.key) }));
  on("store.set", (_, e) => {
    kept.set(e.key, e.value);
    return { value: undefined };
  });
  on("store.delete", (_, e) => {
    kept.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", () => ({ value: [...kept.keys()] }));
};

test("a reset seen from the messages alone starts a detached precompact with messages [] and no window", async ($, on) => {
  const { say, runs, clock, statuses } = submitSession(on, {}, answering());
  store(on);
  model(on);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);
  await clock.advance(0);
  expect(runsOf(runs, PRECOMPACT)).toEqual([]);

  say(compacted);
  const result = await $.prompt.submit(submitted("where were we?"));

  // The prompt's own context is as any reset's, and did not wait on it.
  expect(windowResets(runs)).toEqual([false, false, true]);
  const context = "context" in result ? result.context : undefined;
  expect(context).toEqual([BOOT, CONTEXT]);
  expect(runsOf(runs, PRECOMPACT)).toEqual([]);

  await clock.advance(0);

  const precompacts = runsOf(runs, PRECOMPACT);
  expect(precompacts).toHaveLength(1);
  expect(precompacts[0]?.argv).toEqual([BIN, PRECOMPACT]);
  const payload = parsed(precompacts[0]?.payload);
  expect(payload).toMatchObject({
    session_id: SESSION,
    cwd: CWD,
    messages: [],
  });
  expect("window" in payload).toBe(false);
  expect(statuses.filter((s) => s?.startsWith("mimir:"))).toEqual([]);
});

test("a first answer carrying requests runs them on the session's model and a second run takes the completions", async ($, on) => {
  const { say, runs, clock } = submitSession(
    on,
    {},
    answering([ASKS, ADVANCED]),
  );
  store(on);
  const asks = model(on, () => answered(SUMMARY_TEXT));
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  say(compacted);
  await $.prompt.submit(submitted("where were we?"));
  await clock.advance(0);

  const precompacts = runsOf(runs, PRECOMPACT);
  expect(precompacts).toHaveLength(2);
  expect(asks).toHaveLength(1);
  const first = parsed(precompacts[0]?.payload);
  expect(first.messages).toEqual([]);
  expect(parsed(precompacts[1]?.payload)).toEqual({
    ...first,
    completions: { summary: { text: SUMMARY_TEXT } },
  });
});

test("a /clear emptying the window with no flag set is a reset that starts a precompact", async ($, on) => {
  const { say, runs, clock } = submitSession(on, {}, answering());
  store(on);
  model(on);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 3);

  say([]);
  await $.prompt.submit(submitted("fresh start"));
  await clock.advance(0);

  expect(runsOf(runs, PRECOMPACT)).toHaveLength(1);
});

test("a reset the reanchor flag announced starts no precompact", async ($, on) => {
  const { say, runs, clock, state } = submitSession(on, {}, answering());
  store(on);
  model(on);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 2);

  // lifecycle.ts set the flag: the host announced the compaction, and its
  // own precompact ran there.
  state.put("reanchor", true);
  say(compacted);
  await $.prompt.submit(submitted("where were we?"));
  await clock.advance(0);

  expect(windowResets(runs)).toEqual([false, false, true]);
  expect(runsOf(runs, PRECOMPACT)).toEqual([]);
});

test("a /clear the engine raised, ending the session, starts no precompact on the next prompt", async ($, on) => {
  const { say, runs, clock, switchTo } = submitSession(on, {}, answering());
  store(on);
  model(on);
  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 3);

  await $.session.end(ending("clear", SESSION));
  switchTo("session-cleared", CWD);
  say([]);
  await $.prompt.submit(submitted("fresh start"));
  await clock.advance(0);

  expect(windowResets(runs)).toEqual([false, false, false, true]);
  expect(runsOf(runs, PRECOMPACT)).toEqual([]);
});

test("ordinary prompts continuing the window start no precompact", async ($, on) => {
  const { say, runs, clock } = submitSession(on, {}, answering());
  store(on);
  model(on);

  await converse((t) => $.prompt.submit(submitted(t)), say, 1, 4);
  await clock.advance(0);

  expect(runsOf(runs, PRECOMPACT)).toEqual([]);
});

test("a session's first prompt starts no precompact, whatever the conversation holds", async ($, on) => {
  const { say, runs, clock } = submitSession(on, {}, answering());
  store(on);
  model(on);

  say([...exchange(1), ...exchange(2)]);
  await $.prompt.submit(submitted("question 3"));
  await clock.advance(0);

  expect(runsOf(runs, PRECOMPACT)).toEqual([]);
});
