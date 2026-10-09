import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/t";
const SESSION = "sess-1";
const CWD = "/work/repo";
const CONTEXT = "<retrieved_context>one memory</retrieved_context>";

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

test("runs mimir-cc retrieve with the UserPromptSubmit payload and attaches its context", async ($, on) => {
  mock.env(on, { HOME });
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  const runs: Run[] = [];
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    return exited(
      0,
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: CONTEXT,
        },
        systemMessage: "↻ Retrieved 1 memory",
      }),
    );
  });
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }));

  const result = await $.prompt.submit(submitted("what do we know?"));

  expect(runs).toEqual([
    {
      argv: [`${HOME}/.local/bin/mimir-cc`, "retrieve"],
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

test("passes the prompt through untouched when the binary has nothing to add", async ($, on) => {
  mock.env(on, { HOME });
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  on("process.run", () => exited(0));
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }));

  const result = await $.prompt.submit(submitted("hello", ["prior"]));

  expect(result).toEqual({ text: "hello", context: ["prior"] });
});

test("fails open when the binary exits non-zero", async ($, on) => {
  mock.env(on, { HOME });
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("process.run", () => exited(2));
  on("prompt.submit", (_, e) => ({ text: e.text }));

  const result = await $.prompt.submit(submitted("hello"));

  expect(result).toEqual({ text: "hello" });
  expect(statuses).toEqual(["mimir: retrieve failed (exit 2)"]);
});

test("fails open when the binary cannot be run at all", async ($, on) => {
  mock.env(on, { HOME });
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  on("ui.status", () => ({ value: undefined }));
  on("process.run", () => {
    throw new Error("ENOENT");
  });
  on("prompt.submit", (_, e) => ({ text: e.text }));

  const result = await $.prompt.submit(submitted("hello"));

  expect(result).toEqual({ text: "hello" });
});
