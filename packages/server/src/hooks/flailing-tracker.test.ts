import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "./flailing-tracker";
import {
  computeScore,
  extractTarget,
  FlailingTracker,
  isErrorResult,
  resultSnippet,
} from "./flailing-tracker";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    toolName: "read",
    target: "/path/to/file.ts",
    resultSnippet: "OK",
    isError: false,
    at: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractTarget
// ---------------------------------------------------------------------------

describe("extractTarget", () => {
  test("returns path for file operations", () => {
    expect(extractTarget("read", { path: "/src/file.ts" })).toBe("/src/file.ts");
    expect(extractTarget("write", { path: "./output.txt" })).toBe("./output.txt");
  });

  test("extracts path from bash commands", () => {
    expect(
      extractTarget("bash", { command: "cat /etc/passwd" })
    ).toBe("/etc/passwd");
    expect(
      extractTarget("bash", { command: "ls ./src/" })
    ).toBe("./src/");
    expect(
      extractTarget("bash", { command: "npm run build" })
    ).toBe("npm run build");
  });

  test("extracts query from search tools", () => {
    expect(
      extractTarget("grep", { query: "function.*test" })
    ).toBe("function.*test");
  });

  test("returns first string arg as fallback", () => {
    expect(
      extractTarget("unknown", { foo: "bar", baz: 123 })
    ).toBe("bar");
  });

  test("returns 'unknown' when no string args", () => {
    expect(extractTarget("unknown", { count: 123 })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// isErrorResult
// ---------------------------------------------------------------------------

describe("isErrorResult", () => {
  test("detects error in string result", () => {
    expect(isErrorResult("Error: something failed")).toBe(true);
    expect(isErrorResult("ENOENT: no such file")).toBe(true);
    expect(isErrorResult("EACCES: permission denied")).toBe(true);
    expect(isErrorResult("Exception: stack trace")).toBe(true);
    expect(isErrorResult("PANIC: unrecoverable")).toBe(true);
  });

  test("detects error in object result", () => {
    expect(isErrorResult({ error: "failed" })).toBe(true);
    expect(isErrorResult({ message: "not found" })).toBe(true);
  });

  test("returns false for success results", () => {
    expect(isErrorResult("OK")).toBe(false);
    expect(isErrorResult({ status: "success" })).toBe(false);
    expect(isErrorResult("File written successfully")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resultSnippet
// ---------------------------------------------------------------------------

describe("resultSnippet", () => {
  test("returns first 200 chars of string", () => {
    const long = "x".repeat(300);
    expect(resultSnippet(long)).toBe("x".repeat(200));
  });

  test("trims whitespace", () => {
    expect(resultSnippet("  hello world  ")).toBe("hello world");
  });

  test("stringifies objects", () => {
    const result = resultSnippet({ foo: "bar" });
    expect(result).toBe('{"foo":"bar"}');
  });
});

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------

describe("computeScore", () => {
  test("returns 0.0 for empty window", () => {
    expect(computeScore([])).toBe(0.0);
  });

  test("returns 0.0 for single tool call", () => {
    expect(computeScore([makeRecord()])).toBe(0.0);
  });

  test("repetition: 2x same (tool, target) = 0.17", () => {
    const records = [
      makeRecord(),
      makeRecord(),
    ];
    // maxCount = 2, score = (2-1)/(7-1) = 1/6 ≈ 0.17
    expect(computeScore(records)).toBeCloseTo(0.17, 2);
  });

  test("repetition: 3x same (tool, target) = 0.33", () => {
    const records = [
      makeRecord(),
      makeRecord(),
      makeRecord(),
    ];
    // maxCount = 3, score = (3-1)/(7-1) = 2/6 ≈ 0.33
    expect(computeScore(records)).toBeCloseTo(0.33, 2);
  });

  test("repetition: 7x same (tool, target) = 1.0", () => {
    const records = Array(7).fill(null).map(() => makeRecord());
    // maxCount = 7, score = (7-1)/(7-1) = 1.0
    expect(computeScore(records)).toBe(1.0);
  });

  test("error run: 2 consecutive identical errors = 0.5", () => {
    const records = [
      makeRecord({ isError: true, resultSnippet: "Error: ENOENT" }),
      makeRecord({ isError: true, resultSnippet: "Error: ENOENT" }),
    ];
    // errorRun = 2, score = 2/4 = 0.5
    expect(computeScore(records)).toBeCloseTo(0.5, 2);
  });

  test("error run: 4 consecutive identical errors = 1.0", () => {
    const records = [
      makeRecord({ isError: true, resultSnippet: "Error: ENOENT" }),
      makeRecord({ isError: true, resultSnippet: "Error: ENOENT" }),
      makeRecord({ isError: true, resultSnippet: "Error: ENOENT" }),
      makeRecord({ isError: true, resultSnippet: "Error: ENOENT" }),
    ];
    // errorRun = 4, score = 4/4 = 1.0
    expect(computeScore(records)).toBe(1.0);
  });

  test("mixed signals — highest wins", () => {
    // 3 repetitions (0.33) but 4 consecutive errors (1.0)
    const records = [
      makeRecord({ toolName: "read", target: "a", isError: true, resultSnippet: "Error!" }),
      makeRecord({ toolName: "read", target: "a", isError: true, resultSnippet: "Error!" }),
      makeRecord({ toolName: "read", target: "a", isError: true, resultSnippet: "Error!" }),
      makeRecord({ toolName: "read", target: "a", isError: true, resultSnippet: "Error!" }),
    ];
    expect(computeScore(records)).toBe(1.0);
  });

  test("different targets don't count as repetition", () => {
    const records = [
      makeRecord({ target: "/a" }),
      makeRecord({ target: "/b" }),
      makeRecord({ target: "/c" }),
    ];
    // maxCount = 1 for each unique (tool, target), so score = 0
    expect(computeScore(records)).toBe(0.0);
  });

test("non-consecutive errors don't count as run", () => {
    const records = [
      makeRecord({ target: "a", isError: true, resultSnippet: "Error!" }),
      makeRecord({ target: "b", isError: false, resultSnippet: "OK" }),
      makeRecord({ target: "c", isError: true, resultSnippet: "Error!" }),
    ];
    // Different targets = no repetition (score 0)
    // Error run is broken by success, so max run = 1, score = 1/4 = 0.25
    expect(computeScore(records)).toBeCloseTo(0.25, 2);
  });
});

// ---------------------------------------------------------------------------
// FlailingTracker
// ---------------------------------------------------------------------------

describe("FlailingTracker", () => {
  let tracker: FlailingTracker;

  beforeEach(() => {
    tracker = new FlailingTracker(20); // default window size
  });

  // --- get + record ---

  test("get creates state for new session", () => {
    const state = tracker.get("new-session");
    expect(state.window).toHaveLength(0);
    expect(state.score).toBe(0.0);
    expect(state.nudged).toBe(false);
    expect(state.nudgeCount).toBe(0);
  });

  test("record adds entry to window", () => {
    tracker.record("session-1", makeRecord());
    const state = tracker.get("session-1");
    expect(state.window).toHaveLength(1);
  });

  test("record updates score", () => {
    // 3 consecutive identical calls: (3-1)/(7-1) ≈ 0.33
    tracker.record("s1", makeRecord());
    tracker.record("s1", makeRecord());
    tracker.record("s1", makeRecord());
    const state = tracker.get("s1");
    expect(state.score).toBeCloseTo(0.33, 2);
  });

  test("window rolls over at max size", () => {
    const smallTracker = new FlailingTracker(3);
    smallTracker.record("s1", makeRecord({ target: "a" }));
    smallTracker.record("s1", makeRecord({ target: "b" }));
    smallTracker.record("s1", makeRecord({ target: "c" }));
    smallTracker.record("s1", makeRecord({ target: "d" }));

    const state = smallTracker.get("s1");
    expect(state.window).toHaveLength(3);
    expect(state.window.map((r) => r.target)).toEqual(["b", "c", "d"]);
  });

  test("sessions are isolated", () => {
    tracker.record("s1", makeRecord({ target: "a" }));
    tracker.record("s2", makeRecord({ target: "b" }));

    expect(tracker.get("s1").window).toHaveLength(1);
    expect(tracker.get("s2").window).toHaveLength(1);
    expect(tracker.get("s1").window[0]!.target).toBe("a");
    expect(tracker.get("s2").window[0]!.target).toBe("b");
  });

  // --- computeScore ---

  test("computeScore returns cached score", () => {
    tracker.record("s1", makeRecord());
    tracker.record("s1", makeRecord());
    tracker.record("s1", makeRecord());

    // Score is computed during record(): (3-1)/(7-1) ≈ 0.33
    expect(tracker.computeScore("s1")).toBeCloseTo(0.33, 2);
  });

  test("computeScore returns 0 for unknown session", () => {
    expect(tracker.computeScore("unknown")).toBe(0.0);
  });

  // --- markNudged ---

  test("markNudged sets flag and increments count", () => {
    tracker.markNudged("s1");
    let state = tracker.get("s1");
    expect(state.nudged).toBe(true);
    expect(state.nudgeCount).toBe(1);

    tracker.markNudged("s1");
    state = tracker.get("s1");
    expect(state.nudgeCount).toBe(2);
  });

  // --- reset ---

  test("reset clears state for session", () => {
    tracker.record("s1", makeRecord());
    tracker.record("s1", makeRecord());
    tracker.markNudged("s1");

    tracker.reset("s1");

    const state = tracker.get("s1");
    expect(state.window).toHaveLength(0);
    expect(state.score).toBe(0.0);
    expect(state.nudged).toBe(false);
    expect(state.nudgeCount).toBe(0);
  });

  // --- clear ---

  test("clear removes all state", () => {
    tracker.record("s1", makeRecord());
    tracker.record("s2", makeRecord());

    tracker.clear();

    expect(tracker.get("s1").window).toHaveLength(0);
    expect(tracker.get("s2").window).toHaveLength(0);
  });
});