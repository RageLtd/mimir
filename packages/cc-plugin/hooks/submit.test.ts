import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { anchorIndexFor, anchorInterval, nextAnchorTurn } from "./submit";

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

/** The flag a compaction leaves for the next prompt (lifecycle.ts). */
const reanchorState = (on: On, initial = false) => {
  let value = initial;
  on("state.get", { key: "reanchor" }, () => ({
    value: { value, version: 0 },
  }));
  on("state.set", { key: "reanchor" }, (_, e) => {
    value = e.value;
    return { value: { isSet: true as const, version: 0 } };
  });
  return { get: () => value };
};

/** Whether the last session's summary is still owed to this one. */
const summaryOwedState = (on: On) => {
  let value: boolean | undefined;
  on("state.get", { key: "summaryOwed" }, () => ({
    value: { value, version: 0 },
  }));
  on("state.set", { key: "summaryOwed" }, (_, e) => {
    value = e.value;
    return { value: { isSet: true as const, version: 0 } };
  });
  return { get: () => value };
};

const session = (
  on: On,
  env: Record<string, string> = {},
  reanchor = reanchorState(on),
) => {
  void reanchor;
  summaryOwedState(on);
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
  const runs: Array<Omit<Run, "stdin"> & { stdin: unknown }> = [];
  on("process.run", (_, e) => {
    runs.push({
      argv: e.argv,
      stdin: JSON.parse(e.init?.stdin ?? "null"),
      env: e.init?.env,
    });
    return exited(0, retrieved(CONTEXT, "↻ Retrieved 1 memory"));
  });

  const result = await $.prompt.submit(submitted("what do we know?"));

  expect(turn.get()).toBe(1);
  expect(runs).toEqual([
    {
      argv: [BIN, "retrieve"],
      stdin: {
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
  expect(statuses).toEqual(["↻ Retrieved 1 memory"]);
});

test("retrieval is told the session's first prompt, and only that one", async ($, on) => {
  session(on);
  turnState(on);
  const retrieves: unknown[] = [];
  on("process.run", (_, e) => {
    if (e.argv[1] === "retrieve") {
      retrieves.push(JSON.parse(e.init?.stdin ?? "{}"));
    }
    return exited(0);
  });

  await $.prompt.submit(submitted("where were we?"));
  await $.prompt.submit(submitted("and then?"));

  expect(retrieves).toMatchObject([
    { prompt: "where were we?", session_start: true },
    { prompt: "and then?", session_start: false },
  ]);
});

const PENDING_STATUS = "↻ Last session's summary is still generating";
const pending = () =>
  JSON.stringify({ summaryPending: true, systemMessage: PENDING_STATUS });

/** Retrieve payloads in order, each answered by the next scripted reply. */
const scriptedRetrieve = (
  on: On,
  replies: Array<() => ReturnType<typeof exited>>,
) => {
  const payloads: unknown[] = [];
  on("process.run", (_, e) => {
    if (e.argv[1] !== "retrieve") return exited(0);
    payloads.push(JSON.parse(e.init?.stdin ?? "{}"));
    const reply = replies[payloads.length - 1];
    return reply ? reply() : exited(0);
  });
  return payloads;
};

test("a summary still generating stays owed: the next prompt asks for it again, and says so on the status line", async ($, on) => {
  const statuses = session(on);
  turnState(on);
  const payloads = scriptedRetrieve(on, [() => exited(0, pending())]);

  await $.prompt.submit(submitted("where were we?"));
  await $.prompt.submit(submitted("and then?"));

  expect(payloads).toMatchObject([
    { prompt: "where were we?", session_start: true },
    { prompt: "and then?", session_start: true },
  ]);
  expect(statuses).toContain(PENDING_STATUS);
});

test("once retrieval answers without a pending summary, it is asked for no more", async ($, on) => {
  session(on);
  turnState(on);
  const payloads = scriptedRetrieve(on, [
    () => exited(0, pending()),
    () => exited(0, retrieved(CONTEXT, "↻ Retrieved 1 memory")),
  ]);

  await $.prompt.submit(submitted("one"));
  await $.prompt.submit(submitted("two"));
  await $.prompt.submit(submitted("three"));

  expect(payloads).toMatchObject([
    { prompt: "one", session_start: true },
    { prompt: "two", session_start: true },
    { prompt: "three", session_start: false },
  ]);
});

test("a first prompt whose retrieve exits non-zero leaves the summary owed", async ($, on) => {
  session(on);
  turnState(on);
  const payloads = scriptedRetrieve(on, [() => exited(2)]);

  await $.prompt.submit(submitted("one"));
  await $.prompt.submit(submitted("two"));

  expect(payloads).toMatchObject([
    { prompt: "one", session_start: true },
    { prompt: "two", session_start: true },
  ]);
});

test("a first prompt whose retrieve cannot run leaves the summary owed", async ($, on) => {
  session(on);
  turnState(on);
  const payloads = scriptedRetrieve(on, [
    () => {
      throw new Error("ENOENT");
    },
  ]);

  await $.prompt.submit(submitted("one"));
  await $.prompt.submit(submitted("two"));

  expect(payloads).toMatchObject([
    { prompt: "one", session_start: true },
    { prompt: "two", session_start: true },
  ]);
});

test("a first prompt whose retrieve prints text that is not JSON fails that leg and leaves the summary owed", async ($, on) => {
  const statuses = session(on);
  turnState(on);
  const payloads = scriptedRetrieve(on, [() => exited(0, "not json at all")]);

  const result = await $.prompt.submit(submitted("one"));

  expect(result).toEqual({ text: "one" });
  expect(statuses.filter((s) => s?.startsWith("mimir:"))).toHaveLength(1);

  await $.prompt.submit(submitted("two"));

  expect(payloads).toMatchObject([
    { prompt: "one", session_start: true },
    { prompt: "two", session_start: true },
  ]);
});

test("a first prompt whose retrieve failed inside and printed only summaryPending stays owed, quietly", async ($, on) => {
  const statuses = session(on);
  turnState(on);
  const payloads = scriptedRetrieve(on, [
    () => exited(0, JSON.stringify({ summaryPending: true })),
  ]);

  const result = await $.prompt.submit(submitted("one"));

  expect(result).toEqual({ text: "one" });
  expect(statuses).toEqual([]);

  await $.prompt.submit(submitted("two"));

  expect(payloads).toMatchObject([
    { prompt: "one", session_start: true },
    { prompt: "two", session_start: true },
  ]);
});

test("every third turn also runs voice-anchor for the next exchange in the rotation", async ($, on) => {
  session(on);
  const turn = turnState(on, 2);
  const runs: Run[] = [];
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    return e.argv[1] === "voice-anchor"
      ? exited(0, `${ANCHOR}\n`)
      : exited(0, retrieved(CONTEXT, "↻ Retrieved 1 memory"));
  });

  const result = await $.prompt.submit(submitted("still there?", ["prior"]));

  expect(turn.get()).toBe(3);
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

test("the first prompt after a compaction is anchored whatever the count, and the cadence restarts from it", async ($, on) => {
  const reanchor = reanchorState(on, true);
  session(on, {}, reanchor);
  const turn = turnState(on, 6);
  const argvs: (readonly string[])[] = [];
  const stdins: (string | undefined)[] = [];
  on("process.run", (_, e) => {
    argvs.push(e.argv);
    stdins.push(e.init?.stdin);
    return exited(0);
  });

  await $.prompt.submit(submitted("where were we?"));

  // Retrieval is told the window was replaced, so it may send again what
  // it sent before the compaction.
  expect(JSON.parse(stdins[0] ?? "{}")).toMatchObject({ window_reset: true });

  // Turn 7 becomes the next anchor turn, 9: the third exchange in the
  // rotation now, and the fourth three prompts on.
  expect(argvs[1]).toEqual([
    BIN,
    "voice-anchor",
    "--session",
    SESSION,
    "--nth",
    "2",
  ]);
  expect(turn.get()).toBe(9);
  expect(reanchor.get()).toBe(false);
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
  turnState(on, 2);
  on("process.run", (_, e) =>
    e.argv[1] === "retrieve" ? exited(2) : exited(0, ANCHOR),
  );

  const result = await $.prompt.submit(submitted("hello"));

  expect(result).toEqual({ text: "hello", context: [ANCHOR] });
  expect(statuses).toEqual(["mimir: retrieve failed (exit 2)"]);
});

test("fails open, counter advanced, when the binary cannot be run at all", async ($, on) => {
  const statuses = session(on);
  const turn = turnState(on, 2);
  on("process.run", () => {
    throw new Error("ENOENT");
  });

  const result = await $.prompt.submit(submitted("hello"));

  expect(turn.get()).toBe(3);
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
