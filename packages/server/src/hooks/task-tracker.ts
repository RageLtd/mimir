/**
 * Background task tracker — in-memory store for backgrounded commands.
 *
 * Tracks long-running commands that were automatically backgrounded by
 * the background task manager hook. Provides completion checking by
 * scanning the tail of log files for exit indicators.
 *
 * Scoped per conversation (by fingerprint). Tasks are pruned on
 * completion or after a configurable age.
 */

import { log } from "../util/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackgroundTask {
  /** Path to the tee'd log file */
  logPath: string;
  /** Category of task (build, test, lint, install, etc.) */
  taskType: string;
  /** Timestamp when the task was dispatched */
  startedAt: number;
  /** Conversation fingerprint (null = global) */
  fingerprint: string | null;
  /** Original command that was backgrounded */
  command: string;
}

export type TaskStatus = "running" | "success" | "failed";

export interface TaskSnapshot {
  taskType: string;
  logPath: string;
  status: TaskStatus;
  elapsedSec: number;
  command: string;
}

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

/**
 * Heuristic patterns that indicate a command completed.
 * Checked against the last ~2KB of the log file.
 */
const SUCCESS_PATTERNS = [
  /Finished\s+(`[^`]+`|dev|release|test)\s+target/i, // cargo build/test
  /warning:\s+\d+\s+warnings?\s+emitted/i, // cargo completed with warnings
  /test result:\s+ok\./i, // cargo test passed
  /Successfully compiled \d+/i, // tsc
  /compiled successfully/i, // webpack/vite
  /✓ Compiled/i, // various bundlers
  /npm warn/i, // npm install finished (warnings are normal)
  /added \d+ packages?/i, // npm install
  /installed \d+ packages?/i, // bun install
  /Done in \d+/i, // bun/yarn
  /BUILD SUCCESS/i, // maven/gradle
  /build completed/i, // generic
];

const FAILURE_PATTERNS = [
  /error\[E\d+\]/i, // cargo error codes
  /error: could not compile/i, // cargo
  /FAILED/i, // cargo test / generic
  /test result:\s+FAILED/i, // cargo test failed
  /npm ERR!/i, // npm
  /error TS\d+:/i, // tsc errors
  /BUILD FAILURE/i, // maven/gradle
  /Exit code:\s*[1-9]/i, // generic non-zero exit
  /Exited with code [1-9]/i, // generic
];

/**
 * Scan the tail of a log file for completion indicators.
 * Returns "running" if no completion pattern matched.
 */
async function scanLogForCompletion(logPath: string): Promise<TaskStatus> {
  try {
    const file = Bun.file(logPath);
    const exists = await file.exists();
    if (!exists) return "running"; // File not created yet or on remote

    const size = file.size;
    if (size === 0) return "running";

    // Read the last 2KB for pattern matching
    const readSize = Math.min(size, 2048);
    const blob = file.slice(size - readSize, size);
    const tail = await blob.text();

    // Check failure first — a failed build also matches some "completed" patterns
    for (const pattern of FAILURE_PATTERNS) {
      if (pattern.test(tail)) return "failed";
    }

    for (const pattern of SUCCESS_PATTERNS) {
      if (pattern.test(tail)) return "success";
    }

    return "running";
  } catch (err) {
    log.debug(
      { logPath, err: err instanceof Error ? err.message : String(err) },
      "failed to read task log, treating as still running",
    );
    return "running";
  }
}

// ---------------------------------------------------------------------------
// TaskTracker
// ---------------------------------------------------------------------------

/** Default max age before pruning stale tasks (1 hour) */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export interface TaskTracker {
  add(task: BackgroundTask): void;
  active(fingerprint: string | null): BackgroundTask[];
  checkCompletion(task: BackgroundTask): Promise<TaskStatus>;
  snapshot(fingerprint: string | null): Promise<TaskSnapshot[]>;
  pruneCompleted(fingerprint: string | null): Promise<number>;
  pruneStale(maxAgeMs?: number): number;
  clear(fingerprint: string | null): void;
  readonly size: number;
}

export function createTaskTracker(): TaskTracker {
  const tasks = new Map<string, BackgroundTask[]>();

  return {
    add(task) {
      const key = task.fingerprint ?? "global";
      const list = tasks.get(key) ?? [];
      list.push(task);
      tasks.set(key, list);

      log.info(
        {
          taskType: task.taskType,
          logPath: task.logPath,
          fingerprint: task.fingerprint,
        },
        "background task registered",
      );
    },

    active(fingerprint) {
      return tasks.get(fingerprint ?? "global") ?? [];
    },

    async checkCompletion(task) {
      return scanLogForCompletion(task.logPath);
    },

    async snapshot(fingerprint) {
      const activeTasks = this.active(fingerprint);
      if (activeTasks.length === 0) return [];

      const now = Date.now();
      return Promise.all(
        activeTasks.map(async (t) => ({
          taskType: t.taskType,
          logPath: t.logPath,
          status: await this.checkCompletion(t),
          elapsedSec: Math.round((now - t.startedAt) / 1000),
          command: t.command,
        })),
      );
    },

    async pruneCompleted(fingerprint) {
      const key = fingerprint ?? "global";
      const currentTasks = tasks.get(key);
      if (!currentTasks || currentTasks.length === 0) return 0;

      const results = await Promise.all(
        currentTasks.map(async (t) => ({
          task: t,
          status: await this.checkCompletion(t),
        })),
      );

      const remaining = results
        .filter((r) => r.status === "running")
        .map((r) => r.task);
      const pruned = currentTasks.length - remaining.length;

      if (remaining.length === 0) {
        tasks.delete(key);
      } else {
        tasks.set(key, remaining);
      }

      if (pruned > 0) {
        log.debug({ fingerprint, pruned }, "pruned completed background tasks");
      }

      return pruned;
    },

    pruneStale(maxAgeMs = DEFAULT_MAX_AGE_MS) {
      const cutoff = Date.now() - maxAgeMs;
      let pruned = 0;

      for (const [key, taskList] of tasks) {
        const remaining = taskList.filter((t) => t.startedAt > cutoff);
        pruned += taskList.length - remaining.length;

        if (remaining.length === 0) {
          tasks.delete(key);
        } else {
          tasks.set(key, remaining);
        }
      }

      if (pruned > 0) {
        log.debug({ pruned }, "pruned stale background tasks");
      }

      return pruned;
    },

    clear(fingerprint) {
      tasks.delete(fingerprint ?? "global");
    },

    get size() {
      let total = 0;
      for (const taskList of tasks.values()) {
        total += taskList.length;
      }
      return total;
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: TaskTracker | null = null;

/** Get or create the global task tracker instance. */
export function getTaskTracker() {
  if (!instance) {
    instance = createTaskTracker();
  }
  return instance;
}

/** Replace the global instance (for testing). */
export function setTaskTracker(tracker: TaskTracker) {
  instance = tracker;
}
