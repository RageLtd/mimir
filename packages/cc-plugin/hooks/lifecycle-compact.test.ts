import { expect, mock, test } from "claude-code/testing";
import {
  anchorState,
  answered,
  conversation,
  FACTS,
  model,
  parsed,
  pendingState,
  phases,
  remaining,
  rows,
  SUMMARY,
  TURN,
  turnOne,
  turnTwo,
} from "./__tests__/lifecycle-fixtures";
import { PRECOMPACT_COMPLETION_TIMEOUT_MS } from "./binary";
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

test("a compaction hands the undistilled tail to precompact and re-anchors on what remains", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("session.compact", () => ({ messages: remaining }));

  const result = await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  const [run] = runsOf(runs, "precompact");
  expect(run?.argv).toEqual([BIN, "precompact"]);
  expect(parsed(run?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    trigger: "manual",
    messages: turnTwo,
    host_completions: true,
  });
  expect(result).toMatchObject({ messages: remaining });
  expect(anchor.get()).toEqual(anchorOf(remaining));
});

test("a compaction re-anchors at once and runs precompact on the pre-compaction tail afterwards", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  const pending = pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("session.compact", () => ({ messages: remaining }));

  const result = await $.session.compact({ trigger: "manual", messages: rows });

  expect(result).toMatchObject({ messages: remaining });
  expect(runs).toEqual([]);
  expect(anchor.get()).toEqual(anchorOf(remaining));

  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(1);
  expect(parsed(precompacts[0]?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    trigger: "manual",
    messages: turnTwo,
    host_completions: true,
  });
  expect(anchor.get()).toEqual(anchorOf(remaining));
  expect(pending.get()).toBeNull();
});

test("a compaction during an in-flight persist takes over pending and the persist's late writes miss", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  const pending = pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("session.compact", () => ({ messages: remaining }));
  const distilled = anchorOf([...turnOne, ...turnTwo]);

  await $.turn.complete(TURN);

  expect(runs).toEqual([]);
  expect(pending.get()).not.toBeNull();

  const result = await $.session.compact({ trigger: "manual", messages: rows });

  expect(result).toMatchObject({ messages: remaining });
  expect(runs).toEqual([]);
  expect(anchor.get()).toEqual(anchorOf(remaining));
  // The precompact's claim: the same anchor as the persist's, but its own write.
  expect(pending.get()?.anchor).toEqual(distilled);
  const claims = pending.writes();
  expect(claims).toHaveLength(2);
  expect(claims.every((claim) => claim !== null)).toBe(true);

  await clock.advance(0);

  expect(runsOf(runs, "persist")).toHaveLength(1);
  expect(runsOf(runs, "precompact")).toHaveLength(1);
  // Persist and precompact both wrote on the version they read before the re-anchor.
  expect(
    anchor.attempts.filter(
      (a) => JSON.stringify(a.value) === JSON.stringify(distilled),
    ),
  ).toEqual([
    { value: distilled, ifVersion: 1, isSet: false },
    { value: distilled, ifVersion: 1, isSet: false },
  ]);
  expect(anchor.get()).toEqual(anchorOf(remaining));
  // Each leg clears on its own claim's version: the persist's (1) was taken
  // over by the precompact's (2), so only the precompact's clear lands.
  expect(pending.attempts).toContainEqual({
    value: null,
    ifVersion: 1,
    isSet: false,
  });
  expect(pending.attempts).toContainEqual({
    value: null,
    ifVersion: 2,
    isSet: true,
  });
  expect(pending.get()).toBeNull();
});

test("a deferred precompact's anchor write misses once the compaction re-anchored", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  const precompacted = anchorOf([...turnOne, ...turnTwo]);
  // Written on the version the hook read before the compaction re-anchored.
  expect(anchor.attempts).toContainEqual({
    value: precompacted,
    ifVersion: 1,
    isSet: false,
  });
  expect(anchor.writes()).not.toContainEqual(precompacted);
  expect(anchor.get()).toEqual(anchorOf(remaining));
});

test("precompact's summary and facts requests each run, and both replies go back", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases(
      { advance: false, requests: { summary: SUMMARY, facts: FACTS } },
      { advance: true },
    ),
  );
  const asks = model(on, (e) =>
    answered(e.system === "SUM-S" ? "the summary" : '["a fact"]'),
  );
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  expect(asks).toHaveLength(2);
  const bySystem = (system: string) => asks.find((e) => e.system === system);
  expect(bySystem("SUM-S")?.prompt).toBe("SUM-P");
  expect(bySystem("SUM-S")?.maxTokens).toBe(1024);
  expect(bySystem("SUM-S")?.model).toBe("haiku");
  expect(bySystem("S")?.prompt).toBe("P");
  expect(bySystem("S")?.maxTokens).toBe(2048);
  expect(bySystem("S")?.model).toBe("haiku");
  for (const ask of asks)
    expect(ask.timeoutMs).toBe(PRECOMPACT_COMPLETION_TIMEOUT_MS);
  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(2);
  const [first, second] = precompacts;
  expect(parsed(second?.stdin)).toEqual({
    ...parsed(first?.stdin),
    completions: {
      summary: { text: "the summary" },
      facts: { text: '["a fact"]' },
    },
  });
});

test("a rejected facts completion still lets the summary go back to precompact", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases(
      { advance: false, requests: { summary: SUMMARY, facts: FACTS } },
      { advance: true },
    ),
  );
  on("model.complete", (_, e) => {
    if (e.system === "S") throw new Error("model haiku is not allowed");
    return { value: answered("the summary") };
  });
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  const precompacts = runsOf(runs, "precompact");
  expect(precompacts).toHaveLength(2);
  const [, second] = precompacts;
  const { completions } = parsed(second?.stdin);
  expect(completions?.summary).toEqual({ text: "the summary" });
  expect(completions?.facts?.error).toContain("model.complete");
  expect(statuses).toEqual([]);
});

test("a precompact that asks for completions on its second run gets no third", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
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
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  expect(runsOf(runs, "precompact")).toHaveLength(2);
  expect(asks).toHaveLength(1);
  expect(statuses).toEqual(["mimir: precompact asked for completions twice"]);
});

test("a skipped compaction keeps the anchor precompact advanced to", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on);
  pendingState(on);
  conversation(on, turnOne);
  binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("session.compact", () => ({ skip: "not now" }));

  await $.session.compact({ trigger: "auto", messages: rows });
  await clock.advance(0);

  expect(anchor.get()).toEqual(anchorOf(turnOne));
});

test("a precompute and a subagent's compaction pass over the plugin", async ($, on) => {
  session(on);
  const clock = mock.clock(on);
  const anchor = anchorState(on);
  pendingState(on);
  conversation(on, turnOne);
  const runs = binary(on);
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "precompute", messages: rows });
  await $.session.compact({
    trigger: "auto",
    agentId: "agent-1",
    messages: rows,
  });
  await clock.advance(0);

  expect(runsOf(runs, "precompact")).toEqual([]);
  expect(anchor.get()).toBeUndefined();
});

test("a failing leg shows a status line and the event passes on", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  anchorState(on);
  pendingState(on);
  conversation(on, turnOne);
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("session.compact", () => ({ messages: remaining }));
  on("process.run", (_, e) => {
    if (e.argv[1] === "precompact") throw new Error("ENOENT");
    return exited(e.argv[1] === "persist" ? 4 : 0);
  });

  const ended = await $.turn.complete(TURN);
  const compacted = await $.session.compact({
    trigger: "manual",
    messages: rows,
  });
  await clock.advance(0);

  expect(ended).toEqual({ text: "Then this." });
  expect(compacted).toMatchObject({ messages: remaining });
  expect(statuses).toEqual([
    "mimir: persist failed (exit 4)",
    "mimir: precompact failed",
  ]);
});

test("a compaction's re-anchor is kept in the store for the session's next start", async ($, on) => {
  const kept = new Map<string, unknown>();
  session(on, {}, kept);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  binary(on, () => exited(0, JSON.stringify({ advance: false })));
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "manual", messages: rows });
  await clock.advance(0);

  expect(kept.get(`distilled:${SESSION}`)).toEqual(anchorOf(remaining));
});
