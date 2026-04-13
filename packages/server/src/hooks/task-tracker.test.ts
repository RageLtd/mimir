import { beforeEach, describe, expect, test } from "bun:test";
import type { BackgroundTask } from "./task-tracker";
import { TaskTracker } from "./task-tracker";

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    logPath: "/tmp/mimir-build-1234.log",
    taskType: "build",
    startedAt: Date.now(),
    fingerprint: "test-fp",
    command: "cargo build",
    ...overrides,
  };
}

describe("TaskTracker", () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    tracker = new TaskTracker();
  });

  // --- add + active ---

  test("add registers a task retrievable by fingerprint", () => {
    tracker.add(makeTask());
    expect(tracker.active("test-fp")).toHaveLength(1);
  });

  test("active returns empty array for unknown fingerprint", () => {
    expect(tracker.active("unknown")).toHaveLength(0);
  });

  test("multiple tasks for same fingerprint accumulate", () => {
    tracker.add(makeTask({ logPath: "/tmp/a.log" }));
    tracker.add(makeTask({ logPath: "/tmp/b.log" }));
    expect(tracker.active("test-fp")).toHaveLength(2);
  });

  test("tasks with different fingerprints are isolated", () => {
    tracker.add(makeTask({ fingerprint: "fp-1" }));
    tracker.add(makeTask({ fingerprint: "fp-2" }));
    expect(tracker.active("fp-1")).toHaveLength(1);
    expect(tracker.active("fp-2")).toHaveLength(1);
  });

  test("null fingerprint maps to global", () => {
    tracker.add(makeTask({ fingerprint: null }));
    expect(tracker.active(null)).toHaveLength(1);
  });

  // --- size ---

  test("size counts all tasks across fingerprints", () => {
    tracker.add(makeTask({ fingerprint: "fp-1" }));
    tracker.add(makeTask({ fingerprint: "fp-2" }));
    tracker.add(makeTask({ fingerprint: "fp-1" }));
    expect(tracker.size).toBe(3);
  });

  test("size is 0 when empty", () => {
    expect(tracker.size).toBe(0);
  });

  // --- clear ---

  test("clear removes all tasks for a fingerprint", () => {
    tracker.add(makeTask({ fingerprint: "fp-1" }));
    tracker.add(makeTask({ fingerprint: "fp-2" }));
    tracker.clear("fp-1");
    expect(tracker.active("fp-1")).toHaveLength(0);
    expect(tracker.active("fp-2")).toHaveLength(1);
  });

  // --- pruneStale ---

  test("pruneStale removes tasks older than maxAge", () => {
    const old = makeTask({ startedAt: Date.now() - 2 * 60 * 60 * 1000 }); // 2h ago
    const fresh = makeTask({
      startedAt: Date.now(),
      logPath: "/tmp/fresh.log",
    });
    tracker.add(old);
    tracker.add(fresh);

    const pruned = tracker.pruneStale(60 * 60 * 1000); // 1h max age
    expect(pruned).toBe(1);
    expect(tracker.active("test-fp")).toHaveLength(1);
    expect(tracker.active("test-fp")[0]!.logPath).toBe("/tmp/fresh.log");
  });

  test("pruneStale returns 0 when nothing to prune", () => {
    tracker.add(makeTask());
    expect(tracker.pruneStale()).toBe(0);
  });

  test("pruneStale cleans up empty fingerprint entries", () => {
    const old = makeTask({ startedAt: Date.now() - 2 * 60 * 60 * 1000 });
    tracker.add(old);
    tracker.pruneStale(60 * 60 * 1000);
    expect(tracker.size).toBe(0);
  });

  // --- checkCompletion (log file not found → running) ---

  test("checkCompletion returns running for nonexistent log", async () => {
    const task = makeTask({ logPath: "/tmp/nonexistent-mimir-test.log" });
    const status = await tracker.checkCompletion(task);
    expect(status).toBe("running");
  });

  // --- snapshot ---

  test("snapshot returns empty array when no tasks", async () => {
    const snap = await tracker.snapshot("test-fp");
    expect(snap).toHaveLength(0);
  });

  test("snapshot includes all tasks with elapsed time", async () => {
    const task = makeTask({ startedAt: Date.now() - 5000 }); // 5s ago
    tracker.add(task);

    const snap = await tracker.snapshot("test-fp");
    expect(snap).toHaveLength(1);
    expect(snap[0]!.taskType).toBe("build");
    expect(snap[0]!.elapsedSec).toBeGreaterThanOrEqual(4);
    expect(snap[0]!.command).toBe("cargo build");
    // Log doesn't exist so status is "running"
    expect(snap[0]!.status).toBe("running");
  });

  // --- pruneCompleted (with no log = running, so nothing pruned) ---

  test("pruneCompleted keeps running tasks", async () => {
    tracker.add(makeTask({ logPath: "/tmp/nonexistent.log" }));
    const pruned = await tracker.pruneCompleted("test-fp");
    expect(pruned).toBe(0);
    expect(tracker.active("test-fp")).toHaveLength(1);
  });
});
