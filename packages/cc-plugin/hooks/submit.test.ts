import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { anchorIndexFor, anchorInterval } from "./submit";

const HOME = "/home/t";
const BIN = `${HOME}/.local/bin/mimir-cc`;
const SESSION = "sess-1";
const CWD = "/work/repo";
const CONTEXT = "<retrieved_context>one memory</retrieved_context>";
const ANCHOR = "<voice_anchor>\nMimir: Aye.\n</voice_anchor>";

type Run = { argv: readonly string[]; stdin?: string; env?: object };

const submitted = (text: string, context?: readonly string[]) => ({
  text,
  wait: false,
  origin: { kind: "composer" } as const,
  ...(context ? { context } : {}),
});

const exited = (exitCode: number, stdout = "") => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

const retrieved = (context: string, message: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
    systemMessage: message,
  });

/** The session's turn counter, held in memory the way the host holds it. */
const turnState = (on: On, initial?: number) => {
  let value = initial;
  let version = initial === undefined ? 0 : 1;
  on("state.get", { key: "turn" }, () => ({ value: { value, version } }));
  on("state.set", { key: "turn" }, (_, e) => {
    value = e.value;
    version += 1;
    return { value: { isSet: true as const, version } };
  });
  return { get: () => value };
};

const session = (on: On, env: Record<string, string> = {}) => {
  mock.env(on, { HOME, ...env });
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }));
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  return statuses;
};

test("counts the turn and runs retrieve with the UserPromptSubmit payload, attaching its context", async ($, on) => {
  const statuses = session(on);
  const turn = turnState(on);
  const runs: Run[] = [];
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    return exited(0, retrieved(CONTEXT, "↻ Retrieved 1 memory"));
  });

  const result = await $.prompt.submit(submitted("what do we know?"));

  expect(turn.get()).toBe(1);
  expect(runs).toEqual([
    {
      argv: [BIN, "retrieve"],
      stdin: JSON.stringify({
        session_id: SESSION,
        hook_event_name: "UserPromptSubmit",
        prompt: "what do we know?",
        cwd: CWD,
      }),
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(result).toEqual({ text: "what do we know?", context: [CONTEXT] });
  expect(statuses).toEqual(["↻ Retrieved 1 memory"]);
});

test("every fifth turn also runs voice-anchor for the next exchange in the rotation", async ($, on) => {
  session(on);
  const turn = turnState(on, 4);
  const runs: Run[] = [];
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    return e.argv[1] === "voice-anchor"
      ? exited(0, `${ANCHOR}\n`)
      : exited(0, retrieved(CONTEXT, "↻ Retrieved 1 memory"));
  });

  const result = await $.prompt.submit(submitted("still there?", ["prior"]));

  expect(turn.get()).toBe(5);
  expect(runs[1]).toEqual({
    argv: [BIN, "voice-anchor", "--session", SESSION, "--nth", "0"],
    stdin: undefined,
    env: { MIMIR_ACTIVE: "1" },
  });
  expect(result).toEqual({
    text: "still there?",
    context: ["prior", CONTEXT, ANCHOR],
  });
});

test("MIMIR_ANCHOR_INTERVAL sets the cadence", async ($, on) => {
  session(on, { MIMIR_ANCHOR_INTERVAL: "2" });
  turnState(on, 3);
  const argvs: (readonly string[])[] = [];
  on("process.run", (_, e) => {
    argvs.push(e.argv);
    return exited(0);
  });

  await $.prompt.submit(submitted("hello"));

  expect(argvs).toEqual([
    [BIN, "retrieve"],
    [BIN, "voice-anchor", "--session", SESSION, "--nth", "1"],
  ]);
});

test("passes the prompt through untouched when neither leg has anything to add", async ($, on) => {
  session(on);
  turnState(on);
  on("process.run", () => exited(0));

  const result = await $.prompt.submit(submitted("hello", ["prior"]));

  expect(result).toEqual({ text: "hello", context: ["prior"] });
});

test("a failing leg costs only itself", async ($, on) => {
  const statuses = session(on);
  turnState(on, 4);
  on("process.run", (_, e) =>
    e.argv[1] === "retrieve" ? exited(2) : exited(0, ANCHOR),
  );

  const result = await $.prompt.submit(submitted("hello"));

  expect(result).toEqual({ text: "hello", context: [ANCHOR] });
  expect(statuses).toEqual(["mimir: retrieve failed (exit 2)"]);
});

test("fails open, counter advanced, when the binary cannot be run at all", async ($, on) => {
  const statuses = session(on);
  const turn = turnState(on, 4);
  on("process.run", () => {
    throw new Error("ENOENT");
  });

  const result = await $.prompt.submit(submitted("hello"));

  expect(turn.get()).toBe(5);
  expect(result).toEqual({ text: "hello" });
  expect(statuses).toEqual([
    "mimir: retrieve failed",
    "mimir: voice anchor failed",
  ]);
});

test("cadence helpers", async () => {
  expect(anchorInterval(undefined)).toBe(5);
  expect(anchorInterval("3")).toBe(3);
  expect(anchorInterval("0")).toBe(5);
  expect(anchorInterval("nope")).toBe(5);
  expect([1, 4, 5, 9, 10, 15].map((t) => anchorIndexFor(t, 5))).toEqual([
    null,
    null,
    0,
    null,
    1,
    2,
  ]);
});
