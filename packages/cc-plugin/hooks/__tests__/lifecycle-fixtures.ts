/**
 * Shared fixtures for the lifecycle kit tests: the conversation, the
 * `$.state` keys the legs read and write, the session's model, and the
 * binary's phased answers.
 */

import type { ModelCompleteInput, ModelCompleteResult, On } from "claude-code";
import type { MimirAnchor, MimirPending } from "../../types";
import type { Message } from "../messages";
import { exited } from "../support.test-helpers";

export const parsed = (stdin: string | undefined) => JSON.parse(stdin ?? "{}");

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
export const turnOne = [user("hello"), assistant("Aye.")];
export const turnTwo = [user("and then?"), assistant("Then this.")];
export const turnThree = [user("and after?"), assistant("After that.")];

/** One `$.state.set` as the host saw it: the value, its condition, whether it landed. */
type Attempt<T> = {
  readonly value: T;
  readonly ifVersion: number | undefined;
  readonly isSet: boolean;
};

/** A `$.state` value held in memory the way the host holds it. */
const held = <T>(initial: T | undefined) => {
  let value = initial;
  let version = initial === undefined ? 0 : 1;
  const attempts: Attempt<T>[] = [];
  return {
    get: () => value,
    attempts,
    /** The writes that landed, in order. */
    writes: () => attempts.filter((a) => a.isSet).map((a) => a.value),
    read: () => ({ value: { value, version } }),
    write: (next: T, ifVersion?: number) => {
      const isSet = ifVersion === undefined || ifVersion === version;
      attempts.push({ value: next, ifVersion, isSet });
      if (!isSet) return { value: { isSet: false as const, version } };
      value = next;
      version += 1;
      return { value: { isSet: true as const, version } };
    },
  };
};

/** The distilled anchor. */
export const anchorState = (on: On, initial?: MimirAnchor) => {
  const cell = held(initial);
  on("state.get", { key: "distilled" }, cell.read);
  on("state.set", { key: "distilled" }, (_, e) =>
    cell.write(e.value, e.ifVersion),
  );
  return cell;
};

/** A distillation in flight, or none. */
export const pendingState = (on: On, initial?: MimirPending | null) => {
  const cell = held(initial);
  on("state.get", { key: "pending" }, cell.read);
  on("state.set", { key: "pending" }, (_, e) =>
    cell.write(e.value, e.ifVersion),
  );
  return cell;
};

export { PENDING_STALE_MS } from "../lifecycle";
export const NOW = 1_000_000;

/** The main conversation; the returned setter grows it between events. */
export const conversation = (on: On, messages: readonly Message[]) => {
  let current = messages;
  on("session.messages", () => ({
    value: current.map((m) => ({ role: m.role, content: [...m.content] })),
  }));
  return (next: readonly Message[]) => {
    current = next;
  };
};

export const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
export const answered = (text: string): ModelCompleteResult => ({
  isAnswered: true,
  text,
  usage: NO_USAGE,
});

/** Records every `$.model.complete`; `reply` picks the result by request. */
export const model = (
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
export const phases = (...outputs: readonly object[]) => {
  let run = 0;
  return () => {
    const output = outputs[Math.min(run, outputs.length - 1)] ?? {};
    run += 1;
    return exited(0, JSON.stringify(output));
  };
};

export const FACTS = { system: "S", prompt: "P", maxTokens: 2048 };
export const SUMMARY = { system: "SUM-S", prompt: "SUM-P", maxTokens: 1024 };

/** A main-loop turn's end; `{ ...TURN, agentId }` is a subagent's. */
export const TURN = {
  answer: "Then this.",
  durationMs: 10,
  isAborted: false,
  turnId: "turn-2",
  reason: "answer",
} as const;

/** The conversation as a compaction's `e.messages` and its result carry it. */
const row = (role: "user" | "assistant", text: string) => ({
  role,
  text,
  toolUses: [],
});
export const rows = [
  row("user", "hello"),
  row("assistant", "Aye."),
  row("user", "and then?"),
  row("assistant", "Then this."),
];
export const remaining = [
  row("user", "summary"),
  row("assistant", "Then this."),
];
