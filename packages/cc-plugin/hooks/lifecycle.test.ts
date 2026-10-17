import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { MimirAnchor } from "../types";
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
  on("turn.complete", (_, e) => ({ text: e.answer }));

  const result = await $.turn.complete(TURN);

  expect(result).toEqual({ text: "Then this." });
  const [run] = runsOf(runs, "persist");
  expect(run?.argv).toEqual([BIN, "persist"]);
  expect(run?.env).toEqual({ MIMIR_ACTIVE: "1" });
  expect(parsed(run?.stdin)).toEqual({
    session_id: SESSION,
    cwd: CWD,
    messages: turnTwo,
  });
  expect(anchor.get()).toEqual(anchorOf([...turnOne, ...turnTwo]));
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
  });
  expect(result).toMatchObject({ messages: remaining });
  expect(anchor.get()).toEqual(anchorOf(remaining));
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
