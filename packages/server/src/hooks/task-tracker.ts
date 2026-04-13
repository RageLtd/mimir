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
  } catch {
    // Can't read log (permissions, remote filesystem, etc.)
    return "running";
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** Default max age before pruning stale tasks (1 hour) */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export class TaskTracker {
  private tasks = new Map<string, BackgroundTask[]>();

  /** Register a new background task. */
  add(task: BackgroundTask): void {
    const key = task.fingerprint ?? "global";
    const list = this.tasks.get(key) ?? [];
    list.push(task);
    this.tasks.set(key, list);

    log.info(
      {
        taskType: task.taskType,
        logPath: task.logPath,
        fingerprint: task.fingerprint,
      },
      "background task registered",
    );
  }

  /** Get all tasks for a conversation (regardless of completion status). */
  active(fingerprint: string | null): BackgroundTask[] {
    return this.tasks.get(fingerprint ?? "global") ?? [];
  }

  /** Check completion status for a specific task. */
  async checkCompletion(task: BackgroundTask): Promise<TaskStatus> {
    return scanLogForCompletion(task.logPath);
  }

  /**
   * Build a snapshot of all tasks for a conversation with current status.
   * Used for context injection into the system prompt.
   */
  async snapshot(fingerprint: string | null): Promise<TaskSnapshot[]> {
    const tasks = this.active(fingerprint);
    if (tasks.length === 0) return [];

    const now = Date.now();
    return Promise.all(
      tasks.map(async (t) => ({
        taskType: t.taskType,
        logPath: t.logPath,
        status: await this.checkCompletion(t),
        elapsedSec: Math.round((now - t.startedAt) / 1000),
        command: t.command,
      })),
    );
  }

  /** Remove completed tasks for a conversation. */
  async pruneCompleted(fingerprint: string | null): Promise<number> {
    const key = fingerprint ?? "global";
    const tasks = this.tasks.get(key);
    if (!tasks || tasks.length === 0) return 0;

    const results = await Promise.all(
      tasks.map(async (t) => ({
        task: t,
        status: await this.checkCompletion(t),
      })),
    );

    const remaining = results
      .filter((r) => r.status === "running")
      .map((r) => r.task);
    const pruned = tasks.length - remaining.length;

    if (remaining.length === 0) {
      this.tasks.delete(key);
    } else {
      this.tasks.set(key, remaining);
    }

    if (pruned > 0) {
      log.debug({ fingerprint, pruned }, "pruned completed background tasks");
    }

    return pruned;
  }

  /** Remove stale tasks older than maxAgeMs. */
  pruneStale(maxAgeMs = DEFAULT_MAX_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const [key, tasks] of this.tasks) {
      const remaining = tasks.filter((t) => t.startedAt > cutoff);
      pruned += tasks.length - remaining.length;

      if (remaining.length === 0) {
        this.tasks.delete(key);
      } else {
        this.tasks.set(key, remaining);
      }
    }

    if (pruned > 0) {
      log.debug({ pruned }, "pruned stale background tasks");
    }

    return pruned;
  }

  /** Clear all tasks for a conversation. */
  clear(fingerprint: string | null): void {
    this.tasks.delete(fingerprint ?? "global");
  }

  /** Total number of tracked tasks across all conversations. */
  get size(): number {
    let total = 0;
    for (const tasks of this.tasks.values()) {
      total += tasks.length;
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: TaskTracker | null = null;

/** Get or create the global task tracker instance. */
export function getTaskTracker(): TaskTracker {
  if (!instance) {
    instance = new TaskTracker();
  }
  return instance;
}

/** Replace the global instance (for testing). */
export function setTaskTracker(tracker: TaskTracker): void {
  instance = tracker;
}
