import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { READING_STALE_MS } from "./file-context";
import {
  BIN,
  binary,
  CWD,
  exited,
  HOME,
  nudged,
  type Run,
  runsOf,
  SESSION,
  session as sessionAt,
} from "./support.test-helpers";

const NOW = 1_000_000;

/** `session`, plus the clock every claimed Read consults. */
const session = (on: On) => {
  mock.clock(on, { now: NOW });
  return sessionAt(on);
};

const READ = { tool: "Read", file_path: "/work/repo/src/a.ts" } as const;
const READ_RESULT = {
  type: "text" as const,
  file: {
    filePath: READ.file_path,
    content: "export const a = 1;",
    numLines: 1,
    startLine: 1,
    totalLines: 1,
  },
};
const BLOCK =
  '<file_context path="/work/repo/src/a.ts">\n<symbols>\n- const a (line 1)\n</symbols>\n</file_context>';

const readTool = (on: On) =>
  on("tool.call", { tool: "Read" }, () => ({ result: READ_RESULT }));

test("runs file-context beside the read and attaches its block as context", async ($, on) => {
  const statuses = session(on);
  const runs = binary(on, (sub) =>
    sub === "file-context"
      ? exited(0, nudged(BLOCK, "↻ File context: 2 dependents, 1 memories"))
      : exited(0),
  );
  readTool(on);

  const result = await $.tool.call(READ);

  expect(runsOf(runs, "file-context")).toEqual([
    {
      argv: [BIN, "file-context"],
      stdin: JSON.stringify({
        session_id: SESSION,
        hook_event_name: "PreToolUse",
        cwd: CWD,
        tool_name: "Read",
        tool_input: { file_path: READ.file_path },
      }),
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(result.result).toEqual(READ_RESULT);
  expect(result.context).toEqual([BLOCK]);
  expect(statuses).toEqual(["↻ File context: 2 dependents, 1 memories"]);
});

test("a read of a file the index has nothing on comes back untouched", async ($, on) => {
  const statuses = session(on);
  binary(on);
  readTool(on);

  const result = await $.tool.call(READ);

  expect(result.result).toEqual(READ_RESULT);
  expect(result.context).toBeUndefined();
  expect(statuses).toEqual([]);
});

test("a failing binary costs the context, not the read", async ($, on) => {
  const statuses = session(on);
  binary(on, (sub) => (sub === "file-context" ? exited(2) : exited(0)));
  readTool(on);

  const result = await $.tool.call(READ);

  expect(result.result).toEqual(READ_RESULT);
  expect(statuses).toEqual(["mimir: file context failed (exit 2)"]);
});

type Answer = ReturnType<typeof exited>;

const B_PATH = "/work/repo/src/b.ts";
const BLOCK_B = `<file_context path="${B_PATH}">\n<symbols>\n- const b (line 1)\n</symbols>\n</file_context>`;
const SUMMARY = "↻ File context: 2 dependents, 1 memories";

/**
 * Holds the first file-context run open until the test releases it, so a
 * second read can start while it is in flight; every later file-context
 * run is answered at once by `answer`, given the run's stdin. The gate's
 * legs (rules, guard) also run on Read and pass clean.
 */
const heldFirstRun = (
  on: On,
  answer: (stdin: string) => Answer = () => exited(0),
) => {
  const runs: Run[] = [];
  const settle: { release: (outcome: Answer | Error) => void } = {
    release: () => undefined,
  };
  const start: { mark: () => void } = { mark: () => undefined };
  const started = new Promise<void>((resolve) => {
    start.mark = resolve;
  });
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    if (e.argv[1] !== "file-context") return exited(0);
    if (runsOf(runs, "file-context").length > 1)
      return answer(e.init?.stdin ?? "");
    start.mark();
    return new Promise<Answer>((resolve, reject) => {
      settle.release = (outcome) =>
        outcome instanceof Error ? reject(outcome) : resolve(outcome);
    });
  });
  return {
    runs,
    started,
    release: (outcome: Answer | Error) => settle.release(outcome),
  };
};

const fileOf = (run: Run) =>
  JSON.parse(run.stdin ?? "{}").tool_input?.file_path;

test("a second read of a file whose context is in flight runs nothing and attaches nothing", async ($, on) => {
  const statuses = session(on);
  const held = heldFirstRun(on, () => exited(0, nudged(BLOCK, SUMMARY)));
  readTool(on);

  const first = $.tool.call(READ);
  await held.started;
  const second = await $.tool.call(READ);
  held.release(exited(0, nudged(BLOCK, SUMMARY)));
  const owner = await first;

  expect(runsOf(held.runs, "file-context")).toHaveLength(1);
  expect(owner.result).toEqual(READ_RESULT);
  expect(owner.context).toEqual([BLOCK]);
  expect(second.result).toEqual(READ_RESULT);
  expect(second.context).toBeUndefined();
  expect(statuses).toEqual([SUMMARY]);
});

test("reads of the same file at other offsets count as the same file", async ($, on) => {
  session(on);
  const held = heldFirstRun(on, () => exited(0, nudged(BLOCK, SUMMARY)));
  readTool(on);

  const first = $.tool.call(READ);
  await held.started;
  const second = await $.tool.call({ ...READ, offset: 40, limit: 20 });
  held.release(exited(0, nudged(BLOCK, SUMMARY)));
  const owner = await first;

  expect(runsOf(held.runs, "file-context")).toHaveLength(1);
  expect(owner.context).toEqual([BLOCK]);
  expect(second.context).toBeUndefined();
});

test("reads of different files in flight at once each run and each get their own block", async ($, on) => {
  session(on);
  const held = heldFirstRun(on, (stdin) =>
    stdin.includes(B_PATH) ? exited(0, nudged(BLOCK_B)) : exited(0),
  );
  readTool(on);

  const first = $.tool.call(READ);
  await held.started;
  const second = await $.tool.call({ tool: "Read", file_path: B_PATH });
  held.release(exited(0, nudged(BLOCK)));
  const owner = await first;

  expect(runsOf(held.runs, "file-context").map(fileOf)).toEqual([
    READ.file_path,
    B_PATH,
  ]);
  expect(owner.context).toEqual([BLOCK]);
  expect(second.context).toEqual([BLOCK_B]);
});

test("a read after the first has finished runs the binary again; its hash dedupe decides", async ($, on) => {
  session(on);
  const runs = binary(on, (sub) =>
    sub === "file-context" ? exited(0, nudged(BLOCK)) : exited(0),
  );
  readTool(on);

  const first = await $.tool.call(READ);
  const again = await $.tool.call(READ);

  expect(runsOf(runs, "file-context")).toHaveLength(2);
  expect(first.context).toEqual([BLOCK]);
  expect(again.context).toEqual([BLOCK]);
});

const failures = [
  {
    how: "exits non-zero",
    outcome: exited(2),
    status: "mimir: file context failed (exit 2)",
  },
  {
    how: "rejects",
    outcome: new Error("ENOENT"),
    status: "mimir: file context failed",
  },
];

for (const { how, outcome, status } of failures) {
  test(`an in-flight run that ${how} reports once, and the file's next read runs again`, async ($, on) => {
    const statuses = session(on);
    const held = heldFirstRun(on);
    readTool(on);

    const first = $.tool.call(READ);
    await held.started;
    const second = await $.tool.call(READ);
    held.release(outcome);
    const owner = await first;

    expect(owner.result).toEqual(READ_RESULT);
    expect(second.result).toEqual(READ_RESULT);
    expect(runsOf(held.runs, "file-context")).toHaveLength(1);
    expect(statuses).toEqual([status]);

    const later = await $.tool.call(READ);

    expect(later.result).toEqual(READ_RESULT);
    expect(runsOf(held.runs, "file-context")).toHaveLength(2);
  });
}

const NO_ID = "";

/** A claim is stored as `{ at }`; a released one is null or undefined. */
const isRelease = (value: unknown) =>
  value === undefined || value === null || value === false;

/**
 * `reading` in `$.state` over a map the test holds, by path, each at its
 * own version, compare-and-set as the host does it. `seed` holds claims
 * already taken; with `refuseRelease` the write that gives a claim back
 * rejects. `writes` are the writes that landed, in order.
 */
const readingState = (
  on: On,
  seed: Record<string, unknown> = {},
  { refuseRelease = false } = {},
) => {
  const held = new Map(
    Object.entries(seed).map(([id, value]) => [id, { value, version: 1 }]),
  );
  const writes: unknown[] = [];
  on("state.get", { key: "reading" }, (_, e) => ({
    value: held.get(e.id ?? NO_ID) ?? { value: undefined, version: 0 },
  }));
  on("state.set", { key: "reading" }, (_, e) => {
    // A hook's `{ deny }` rejects the caller; a throwing hook is only skipped.
    if (refuseRelease && isRelease(e.value))
      return { deny: "state write refused" };
    const id = e.id ?? NO_ID;
    const was = held.get(id) ?? { value: undefined, version: 0 };
    if (e.ifVersion !== undefined && e.ifVersion !== was.version)
      return { value: { isSet: false as const, version: was.version } };
    const version = was.version + 1;
    held.set(id, { value: e.value, version });
    writes.push(e.value);
    return { value: { isSet: true as const, version } };
  });
  return {
    get: (id: string) => held.get(id)?.value,
    isHeld: (id: string) => !isRelease(held.get(id)?.value),
    writes,
  };
};

/** The bottom Read handler, counting how often the read itself ran. */
const countedReadTool = (on: On) => {
  const reads = { count: 0 };
  on("tool.call", { tool: "Read" }, () => {
    reads.count += 1;
    return { result: READ_RESULT };
  });
  return reads;
};

type AfterClaim = "env.get" | "session.id" | "session.cwd";

/**
 * The session as `session` answers it, but the noun named rejects (a
 * hook's `{ deny }` rejects the caller) while `broken.on` and the file is
 * claimed — so only a read made after the claim fails, not the gate's
 * legs ahead of it. A throwing hook would only be skipped, and `session`
 * already holds these events.
 */
const sessionBreaking = (
  on: On,
  noun: AfterClaim,
  broken: { on: boolean },
  claimed: () => boolean,
) => {
  const fails = (n: AfterClaim) => broken.on && n === noun && claimed();
  const denial = { deny: `${noun} failed` };
  mock.clock(on, { now: NOW });
  on("env.get", (_, e) =>
    fails("env.get") ? denial : { value: e.name === "HOME" ? HOME : undefined },
  );
  on("session.id", () => (fails("session.id") ? denial : { value: SESSION }));
  on("session.cwd", () => (fails("session.cwd") ? denial : { value: CWD }));
  on("agent.list", () => ({ value: [] }));
  on("ui.status", () => ({ value: undefined }));
};

const afterClaim: readonly AfterClaim[] = [
  "env.get",
  "session.id",
  "session.cwd",
];

for (const noun of afterClaim) {
  test(`a read whose ${noun} rejects after its claim still completes, and the file's next read runs again`, async ($, on) => {
    const broken = { on: true };
    const reading = readingState(on);
    sessionBreaking(on, noun, broken, () => reading.isHeld(READ.file_path));
    const runs = binary(on, (sub) =>
      sub === "file-context" ? exited(0, nudged(BLOCK)) : exited(0),
    );
    readTool(on);

    const failed = await $.tool.call(READ);
    broken.on = false;
    const later = await $.tool.call(READ);

    expect(failed.result).toEqual(READ_RESULT);
    expect(later.result).toEqual(READ_RESULT);
    expect(runsOf(runs, "file-context")).toHaveLength(1);
    expect(later.context).toEqual([BLOCK]);
    expect(reading.isHeld(READ.file_path)).toBe(false);
  });
}

test("the claim a read takes is stored as { at: now } and given back when its run settles", async ($, on) => {
  session(on);
  const reading = readingState(on);
  binary(on, (sub) =>
    sub === "file-context" ? exited(0, nudged(BLOCK)) : exited(0),
  );
  readTool(on);

  const result = await $.tool.call(READ);

  expect(result.context).toEqual([BLOCK]);
  expect(reading.writes[0]).toEqual({ at: NOW });
  expect(reading.get(READ.file_path) ?? null).toBeNull();
});

test("a claim older than the stale limit does not block: the read runs the binary and gets its block", async ($, on) => {
  session(on);
  const reading = readingState(on, {
    [READ.file_path]: { at: NOW - READING_STALE_MS - 1 },
  });
  const runs = binary(on, (sub) =>
    sub === "file-context" ? exited(0, nudged(BLOCK)) : exited(0),
  );
  readTool(on);

  const result = await $.tool.call(READ);

  expect(runsOf(runs, "file-context")).toHaveLength(1);
  expect(result.result).toEqual(READ_RESULT);
  expect(result.context).toEqual([BLOCK]);
  expect(reading.get(READ.file_path) ?? null).toBeNull();
});

test("a fresh claim still collapses: the read runs nothing and the claim stands", async ($, on) => {
  session(on);
  const claim = { at: NOW };
  const reading = readingState(on, { [READ.file_path]: claim });
  const runs = binary(on, (sub) =>
    sub === "file-context" ? exited(0, nudged(BLOCK)) : exited(0),
  );
  readTool(on);

  const result = await $.tool.call(READ);

  expect(runsOf(runs, "file-context")).toEqual([]);
  expect(result.result).toEqual(READ_RESULT);
  expect(result.context).toBeUndefined();
  expect(reading.get(READ.file_path)).toEqual(claim);
});

test("a claim goes stale at 30 s, at least twice the binary run's own timeout", async ($, on) => {
  session(on);
  const timeouts: Array<number | undefined> = [];
  on("process.run", (_, e) => {
    if (e.argv[1] === "file-context") timeouts.push(e.init?.timeoutMs);
    return exited(0);
  });
  readTool(on);

  await $.tool.call(READ);

  expect(READING_STALE_MS).toBe(30_000);
  expect(timeouts).toHaveLength(1);
  expect(READING_STALE_MS).toBeGreaterThanOrEqual(
    2 * (timeouts[0] ?? Number.POSITIVE_INFINITY),
  );
});

test("a release that fails does not run the read again, and the owner keeps its block", async ($, on) => {
  const statuses = session(on);
  readingState(on, {}, { refuseRelease: true });
  binary(on, (sub) =>
    sub === "file-context" ? exited(0, nudged(BLOCK, SUMMARY)) : exited(0),
  );
  const reads = countedReadTool(on);

  const owner = await $.tool.call(READ);

  expect(reads.count).toBe(1);
  expect(owner.result).toEqual(READ_RESULT);
  expect(owner.context).toEqual([BLOCK]);
  expect(statuses).toContain(SUMMARY);
});
