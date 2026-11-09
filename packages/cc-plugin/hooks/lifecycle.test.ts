import { expect, mock, test } from "claude-code/testing";
import {
  anchorState,
  answered,
  conversation,
  FACTS,
  model,
  NO_USAGE,
  NOW,
  PENDING_STALE_MS,
  parsed,
  pendingState,
  phases,
  TURN,
  turnOne,
  turnThree,
  turnTwo,
} from "./__tests__/lifecycle-fixtures";
import { PERSIST_COMPLETION_TIMEOUT_MS } from "./binary";
import { anchorOf } from "./messages";
import {
  BIN,
  binary,
  CWD,
  exited,
  runsOf,
  SESSION,
  session,
} from "./support.test-helpers";

test("SessionStart hands its payload, source included, to session-start", async ($, on) => {
  const statuses = session(on);
  const runs = binary(on);
  on("classic.SessionStart", () => ({}));

  await $.classic.SessionStart({ source: "resume", cwd: "/work/repo" });

  const [run] = runsOf(runs, "session-start");
  expect(run?.argv).toEqual([BIN, "session-start"]);
  expect(run?.env).toEqual({ MIMIR_ACTIVE: "1" });
  expect(parsed(run?.stdin)).toMatchObject({
    hook_event_name: "SessionStart",
    source: "resume",
    cwd: "/work/repo",
  });
  expect(statuses).toEqual([]);
});

test("a main-loop turn hands the messages since the anchor to persist and advances it", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  const asks = model(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  const result = await $.turn.complete(TURN);
  await clock.advance(0);

  expect(result).toEqual({ text: "Then this." });
  const persists = runsOf(runs, "persist");
  expect(persists).toHaveLength(1);
  const [run] = persists;
  expect(run?.argv).toEqual([BIN, "persist"]);
  expect(run?.env).toEqual({ MIMIR_ACTIVE: "1" });
  expect(parsed(run?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    messages: turnTwo,
    host_completions: true,
  });
  expect(asks).toEqual([]);
  expect(anchor.get()).toEqual(anchorOf([...turnOne, ...turnTwo]));
});

test("a main-loop turn only schedules persist: nothing runs until the timer fires", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  const pending = pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: true }),
  );
  const asks = model(on, () => answered('["a fact"]'));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  const result = await $.turn.complete(TURN);

  expect(result).toEqual({ text: "Then this." });
  expect(runs).toEqual([]);
  expect(asks).toEqual([]);
  expect(pending.get()).toEqual({
    anchor: anchorOf([...turnOne, ...turnTwo]),
    at: clock.now(),
  });
  expect(anchor.get()).toEqual(initial);

  await clock.advance(0);

  const persists = runsOf(runs, "persist");
  expect(persists).toHaveLength(2);
  const [first, second] = persists;
  expect(parsed(first?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    messages: turnTwo,
    host_completions: true,
  });
  expect(parsed(second?.stdin)).toEqual({
    ...parsed(first?.stdin),
    completions: { facts: { text: '["a fact"]' } },
  });
  expect(asks).toHaveLength(1);
  expect(anchor.get()).toEqual(anchorOf([...turnOne, ...turnTwo]));
  expect(pending.get()).toBeNull();
});

test("a turn ending while persist is pending schedules nothing; the next turn carries its messages", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  const pending = pendingState(on);
  const grow = conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  grow([...turnOne, ...turnTwo, ...turnThree]);
  await $.turn.complete(TURN);

  expect(pending.writes().filter((w) => w !== null)).toHaveLength(1);

  await clock.advance(0);

  const persists = runsOf(runs, "persist");
  expect(persists).toHaveLength(1);
  expect(parsed(persists[0]?.stdin).messages).toEqual(turnTwo);
  expect(anchor.get()).toEqual(anchorOf([...turnOne, ...turnTwo]));
  expect(pending.get()).toBeNull();

  await $.turn.complete(TURN);
  await clock.advance(0);

  const after = runsOf(runs, "persist");
  expect(after).toHaveLength(2);
  expect(parsed(after[1]?.stdin).messages).toEqual(turnThree);
  expect(anchor.get()).toEqual(
    anchorOf([...turnOne, ...turnTwo, ...turnThree]),
  );
  expect(pending.get()).toBeNull();
});

test("a stale pending does not block the next persist", async ($, on) => {
  session(on);
  const clock = mock.clock(on, { now: NOW });
  anchorState(on, anchorOf(turnOne));
  const pending = pendingState(on, {
    anchor: anchorOf(turnOne),
    at: NOW - PENDING_STALE_MS - 1,
  });
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);

  expect(pending.get()).toEqual({
    anchor: anchorOf([...turnOne, ...turnTwo]),
    at: clock.now(),
  });

  await clock.advance(0);

  const persists = runsOf(runs, "persist");
  expect(persists).toHaveLength(1);
  expect(parsed(persists[0]?.stdin).messages).toEqual(turnTwo);
  expect(pending.get()).toBeNull();
});

test("a fresh pending blocks the next persist and stays as it was", async ($, on) => {
  session(on);
  const clock = mock.clock(on, { now: NOW });
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  const inFlight = { anchor: anchorOf(turnOne), at: clock.now() };
  const pending = pendingState(on, inFlight);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(runsOf(runs, "persist")).toEqual([]);
  expect(pending.get()).toEqual(inFlight);
  expect(anchor.get()).toEqual(initial);
});

test("a deferred persist that exits non-zero shows its status and clears pending", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  const pending = pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  binary(on, () => exited(4));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);

  expect(statuses).toEqual([]);

  await clock.advance(0);

  expect(statuses).toEqual(["mimir: persist failed (exit 4)"]);
  expect(anchor.get()).toEqual(initial);
  expect(pending.get()).toBeNull();
});

test("a deferred persist that does not advance leaves the anchor and clears pending", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  const pending = pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  binary(on, () => exited(0, JSON.stringify({ advance: false })));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(anchor.get()).toEqual(initial);
  expect(pending.get()).toBeNull();
  expect(statuses).toEqual([]);
});

test("persist's requests run on the session's model and their replies go back to persist", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: true }),
  );
  const asks = model(on, () => answered('["a fact"]'));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(asks).toHaveLength(1);
  const [ask] = asks;
  expect(ask?.model).toBe("haiku");
  expect(ask?.system).toBe("S");
  expect(ask?.prompt).toBe("P");
  expect(ask?.maxTokens).toBe(2048);
  expect(ask?.timeoutMs).toBe(PERSIST_COMPLETION_TIMEOUT_MS);
  const persists = runsOf(runs, "persist");
  expect(persists).toHaveLength(2);
  const [first, second] = persists;
  expect(second?.argv).toEqual([BIN, "persist"]);
  expect(parsed(second?.stdin)).toEqual({
    ...parsed(first?.stdin),
    completions: { facts: { text: '["a fact"]' } },
  });
  expect(anchor.get()).toEqual(anchorOf([...turnOne, ...turnTwo]));
});

test("the anchor stays where persist's second run does not advance", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: false }),
  );
  model(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(runsOf(runs, "persist")).toHaveLength(2);
  expect(anchor.get()).toEqual(initial);
});

test("a rejected completion goes back to persist as its error, with no status line", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: true }),
  );
  on("model.complete", () => {
    throw new Error("model haiku is not allowed");
  });
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  const persists = runsOf(runs, "persist");
  expect(persists).toHaveLength(2);
  const [, second] = persists;
  // The kit skips a throwing hook and rejects with its own "no implementation
  // for model.complete", so the thrown message never reaches the module.
  expect(parsed(second?.stdin).completions?.facts?.error).toContain(
    "model.complete",
  );
  expect(statuses).toEqual([]);
});

test("a persist that asks for completions on its second run gets no third", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases(
      { advance: false, requests: { facts: FACTS } },
      { advance: false, requests: { facts: FACTS } },
      { advance: true },
    ),
  );
  const asks = model(on, () => answered('["a fact"]'));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(runsOf(runs, "persist")).toHaveLength(2);
  expect(asks).toHaveLength(1);
  expect(anchor.get()).toEqual(initial);
  expect(statuses).toEqual(["mimir: persist asked for completions twice"]);
});

test("an unanswered completion goes back to persist as its reason", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: false }),
  );
  model(on, () => ({
    isAnswered: false,
    reason: "api-error",
    status: 500,
    error: "overloaded",
    usage: NO_USAGE,
  }));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  const [, second] = runsOf(runs, "persist");
  expect(parsed(second?.stdin).completions?.facts?.error).toContain(
    "api-error",
  );
});

test("a persist that fails its first run asks no model", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () =>
    exited(4, JSON.stringify({ advance: false, requests: { facts: FACTS } })),
  );
  const asks = model(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(asks).toEqual([]);
  expect(runsOf(runs, "persist")).toHaveLength(1);
  expect(statuses).toEqual(["mimir: persist failed (exit 4)"]);
});

test("a subagent's turn and a turn with nothing new run nothing", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, turnOne);
  const runs = binary(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete({ ...TURN, agentId: "agent-1" });
  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(runsOf(runs, "persist")).toEqual([]);
});

test("the anchor stays where persist does not advance, so the next turn retries", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on);
  pendingState(on);
  conversation(on, turnOne);
  binary(on, () => exited(0, JSON.stringify({ advance: false })));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  expect(anchor.get()).toBeUndefined();
  expect(statuses).toEqual([]);
});
