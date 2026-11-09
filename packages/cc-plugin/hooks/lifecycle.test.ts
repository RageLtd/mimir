import type { ModelCompleteInput, ModelCompleteResult, On } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { MimirAnchor } from "../types";
import {
  PERSIST_COMPLETION_TIMEOUT_MS,
  PRECOMPACT_COMPLETION_TIMEOUT_MS,
} from "./binary";
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

const parsed = (stdin: string | undefined) => JSON.parse(stdin ?? "{}");

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const turnOne = [user("hello"), assistant("Aye.")];
const turnTwo = [user("and then?"), assistant("Then this.")];

/** The distilled anchor, held in memory the way the host holds it. */
const anchorState = (on: On, initial?: MimirAnchor) => {
  let value = initial;
  let version = initial === undefined ? 0 : 1;
  on("state.get", { key: "distilled" }, () => ({ value: { value, version } }));
  on("state.set", { key: "distilled" }, (_, e) => {
    value = e.value;
    version += 1;
    return { value: { isSet: true as const, version } };
  });
  return { get: () => value };
};

const conversation = (on: On, messages: readonly Message[]) =>
  on("session.messages", () => ({
    value: messages.map((m) => ({ role: m.role, content: [...m.content] })),
  }));

const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const answered = (text: string): ModelCompleteResult => ({
  isAnswered: true,
  text,
  usage: NO_USAGE,
});

/** Records every `$.model.complete`; `reply` picks the result by request. */
const model = (
  on: On,
  reply: (e: ModelCompleteInput) => ModelCompleteResult = () => answered(""),
) => {
  const asks: ModelCompleteInput[] = [];
  on("model.complete", (_, e) => {
    asks.push(e);
    return { value: reply(e) };
  });
  return asks;
};

/** A binary answer per run of the same leg: phase one, then phase two. */
const phases = (...outputs: readonly object[]) => {
  let run = 0;
  return () => {
    const output = outputs[Math.min(run, outputs.length - 1)] ?? {};
    run += 1;
    return exited(0, JSON.stringify(output));
  };
};

const FACTS = { system: "S", prompt: "P", maxTokens: 2048 };
const SUMMARY = { system: "SUM-S", prompt: "SUM-P", maxTokens: 1024 };

/** A main-loop turn's end; `{ ...TURN, agentId }` is a subagent's. */
const TURN = {
  answer: "Then this.",
  durationMs: 10,
  isAborted: false,
  turnId: "turn-2",
  reason: "answer",
} as const;

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
  const anchor = anchorState(on, anchorOf(turnOne));
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  const asks = model(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  const result = await $.turn.complete(TURN);

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

test("persist's requests run on the session's model and their replies go back to persist", async ($, on) => {
  session(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: true }),
  );
  const asks = model(on, () => answered('["a fact"]'));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);

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
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(
    on,
    phases({ advance: false, requests: { facts: FACTS } }, { advance: false }),
  );
  model(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);

  expect(runsOf(runs, "persist")).toHaveLength(2);
  expect(anchor.get()).toEqual(initial);
});

test("a rejected completion goes back to persist as its error, with no status line", async ($, on) => {
  const statuses = session(on);
  anchorState(on, anchorOf(turnOne));
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
  const initial = anchorOf(turnOne);
  const anchor = anchorState(on, initial);
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

  expect(runsOf(runs, "persist")).toHaveLength(2);
  expect(asks).toHaveLength(1);
  expect(anchor.get()).toEqual(initial);
  expect(statuses).toEqual(["mimir: persist asked for completions twice"]);
});

test("an unanswered completion goes back to persist as its reason", async ($, on) => {
  session(on);
  anchorState(on, anchorOf(turnOne));
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

  const [, second] = runsOf(runs, "persist");
  expect(parsed(second?.stdin).completions?.facts?.error).toContain(
    "api-error",
  );
});

test("a persist that fails its first run asks no model", async ($, on) => {
  const statuses = session(on);
  anchorState(on, anchorOf(turnOne));
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () =>
    exited(4, JSON.stringify({ advance: false, requests: { facts: FACTS } })),
  );
  const asks = model(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);

  expect(asks).toEqual([]);
  expect(runsOf(runs, "persist")).toHaveLength(1);
  expect(statuses).toEqual(["mimir: persist failed (exit 4)"]);
});

test("a subagent's turn and a turn with nothing new run nothing", async ($, on) => {
  session(on);
  anchorState(on, anchorOf(turnOne));
  conversation(on, turnOne);
  const runs = binary(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete({ ...TURN, agentId: "agent-1" });
  await $.turn.complete(TURN);

  expect(runsOf(runs, "persist")).toEqual([]);
});

test("the anchor stays where persist does not advance, so the next turn retries", async ($, on) => {
  const statuses = session(on);
  const anchor = anchorState(on);
  conversation(on, turnOne);
  binary(on, () => exited(0, JSON.stringify({ advance: false })));
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);

  expect(anchor.get()).toBeUndefined();
  expect(statuses).toEqual([]);
});

/** The conversation as a compaction's `e.messages` and its result carry it. */
const row = (role: "user" | "assistant", text: string) => ({
  role,
  text,
  toolUses: [],
});
const rows = [
  row("user", "hello"),
  row("assistant", "Aye."),
  row("user", "and then?"),
  row("assistant", "Then this."),
];
const remaining = [row("user", "summary"), row("assistant", "Then this.")];

test("a compaction hands the undistilled tail to precompact and re-anchors on what remains", async ($, on) => {
  session(on);
  const anchor = anchorState(on, anchorOf(turnOne));
  conversation(on, [...turnOne, ...turnTwo]);
  const runs = binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("session.compact", () => ({ messages: remaining }));

  const result = await $.session.compact({ trigger: "manual", messages: rows });

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

test("precompact's summary and facts requests each run, and both replies go back", async ($, on) => {
  session(on);
  anchorState(on, anchorOf(turnOne));
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
  anchorState(on, anchorOf(turnOne));
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
  anchorState(on, anchorOf(turnOne));
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

  expect(runsOf(runs, "precompact")).toHaveLength(2);
  expect(asks).toHaveLength(1);
  expect(statuses).toEqual(["mimir: precompact asked for completions twice"]);
});

test("a skipped compaction keeps the anchor precompact advanced to", async ($, on) => {
  session(on);
  const anchor = anchorState(on);
  conversation(on, turnOne);
  binary(on, () => exited(0, JSON.stringify({ advance: true })));
  on("session.compact", () => ({ skip: "not now" }));

  await $.session.compact({ trigger: "auto", messages: rows });

  expect(anchor.get()).toEqual(anchorOf(turnOne));
});

test("a precompute and a subagent's compaction pass over the plugin", async ($, on) => {
  session(on);
  const anchor = anchorState(on);
  conversation(on, turnOne);
  const runs = binary(on);
  on("session.compact", () => ({ messages: remaining }));

  await $.session.compact({ trigger: "precompute", messages: rows });
  await $.session.compact({
    trigger: "auto",
    agentId: "agent-1",
    messages: rows,
  });

  expect(runsOf(runs, "precompact")).toEqual([]);
  expect(anchor.get()).toBeUndefined();
});

test("a failing leg shows a status line and the event passes on", async ($, on) => {
  const statuses = session(on);
  anchorState(on);
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

  expect(ended).toEqual({ text: "Then this." });
  expect(compacted).toMatchObject({ messages: remaining });
  expect(statuses).toEqual([
    "mimir: persist failed (exit 4)",
    "mimir: precompact failed",
  ]);
});
