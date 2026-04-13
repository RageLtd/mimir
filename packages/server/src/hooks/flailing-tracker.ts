/**
 * Flailing tracker — detects when the model is stuck in unproductive loops.
 *
 * Tracks tool calls per session in a rolling window and computes a flailing
 * score based on:
 * - Repetition: same (tool, target) pair called multiple times
 * - Consecutive errors: identical error messages appearing repeatedly
 *
 * The score is a normalized 0.0–1.0 value. When it exceeds the nudge threshold,
 * the interceptor hook denies the tool call with a "step back and rethink" message.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  /** Tool name */
  toolName: string;
  /** Normalized target — file path for file ops, first arg for bash */
  target: string;
  /** First 200 chars of result (for error comparison) */
  resultSnippet: string;
  /** Whether the result looks like an error */
  isError: boolean;
  /** Timestamp */
  at: number;
}

export interface FlailingState {
  /** Rolling window of recent tool calls (max size from config) */
  window: ToolCallRecord[];
  /** Current computed flailing score (0.0 – 1.0) */
  score: number;
  /** Whether a nudge has already been injected this session */
  nudged: boolean;
  /** Number of nudges given (escalate after repeated nudges fail) */
  nudgeCount: number;
}

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

/** Calling same (tool, target) this many times = score 1.0 */
const REPETITION_CEILING = 7;

/** This many consecutive identical errors = score 1.0 */
const ERROR_RUN_CEILING = 4;

/** Default max window size */
const DEFAULT_WINDOW_SIZE = 20;

// ---------------------------------------------------------------------------
// Target extraction
// ---------------------------------------------------------------------------

/**
 * Extract a normalized target string from tool arguments.
 * This lets us detect repeated operations on the same file/resource.
 */
export function extractTarget(
  toolName: string,
  args: Record<string, unknown>,
): string {
  // File operations — path is the target
  if (args.path && typeof args.path === "string") return args.path;

  // Bash/shell — extract the first "interesting" token
  if (/^(bash|terminal|shell|run_command)$/i.test(toolName)) {
    const cmd = String(args.command ?? args.cmd ?? "");
    // Extract first path-like argument or the base command
    const pathMatch = cmd.match(/(?:^|\s)(\/\S+|\.\/\S+|\S+\.\w+)/);
    return pathMatch?.[1] ?? cmd.slice(0, 80);
  }

  // Search tools — query is the target
  if (args.query && typeof args.query === "string") return args.query;

  // Fallback — first string arg value
  const firstStringArg = Object.values(args).find((v) => typeof v === "string");
  return typeof firstStringArg === "string"
    ? firstStringArg.slice(0, 100)
    : "unknown";
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

/** Heuristic patterns that indicate an error result */
const ERROR_PATTERNS =
  /error|ENOENT|EACCES|EPERM|not found|no such file|failed|exception|panic|denied/i;

/**
 * Heuristic check on the tool result to determine if it's an error.
 * Doesn't need to be perfect — false positives just add small noise to the score.
 */
export function isErrorResult(result: unknown): boolean {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return ERROR_PATTERNS.test(text.slice(0, 500));
}

/**
 * Extract a snippet from the result for comparison.
 * Used to detect consecutive identical errors.
 */
export function resultSnippet(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.slice(0, 200).trim();
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Count occurrences of each (toolName, target) pair in the window.
 * Returns the highest count.
 */
function countRepetition(window: ToolCallRecord[]): number {
  if (window.length === 0) return 0;
  // Count consecutive repetitions (not total)
  let max = 1;
  let current = 1;
  for (let i = 1; i < window.length; i++) {
    const prevKey = `${window[i - 1]?.toolName}::${window[i - 1]?.target}`;
    const currKey = `${window[i]?.toolName}::${window[i]?.target}`;
    if (prevKey === currKey) {
      current++;
      max = Math.max(max, current);
    } else {
      current = 1;
    }
  }
  return max;
}

/**
 * Find the longest run of consecutive identical errors.
 * Returns the length of the longest run where isError is true and
 * resultSnippet matches the previous error.
 */
function countConsecutiveErrors(window: ToolCallRecord[]): number {
  let longest = 0;
  let current = 0;
  let lastSnippet = "";

  for (const entry of window) {
    if (
      entry.isError &&
      entry.resultSnippet === lastSnippet &&
      entry.resultSnippet.length > 0
    ) {
      current++;
      longest = Math.max(longest, current);
    } else if (entry.isError && entry.resultSnippet.length > 0) {
      // New error starts a potential run
      current = 1;
      lastSnippet = entry.resultSnippet;
      longest = Math.max(longest, current);
    } else {
      // Non-error or empty snippet breaks the run
      current = 0;
      lastSnippet = "";
    }
  }

  return longest;
}

/**
 * Compute the flailing score from a window of tool calls.
 * Returns a value between 0.0 and 1.0.
 * Score is the maximum of the repetition and error-run sub-scores.
 */
export function computeScore(window: ToolCallRecord[]): number {
  if (window.length === 0) return 0.0;

  // Repetition score: 0.0 for 1 call, 1.0 for REPETITION_CEILING calls
  const maxReps = countRepetition(window);
  const repetitionScore = Math.min(
    1.0,
    (maxReps - 1) / (REPETITION_CEILING - 1),
  );

  // Error run score: 0.0 for 0 errors, 1.0 for ERROR_RUN_CEILING consecutive
  const errorRun = countConsecutiveErrors(window);
  const errorRunScore = Math.min(1.0, errorRun / ERROR_RUN_CEILING);

  // Final score is the maximum of the two signals
  return Math.max(repetitionScore, errorRunScore);
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class FlailingTracker {
  private state = new Map<string, FlailingState>();
  private windowSize: number;

  constructor(windowSize: number = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  /** Get or create state for a session. */
  get(sessionId: string): FlailingState {
    let state = this.state.get(sessionId);
    if (!state) {
      state = {
        window: [],
        score: 0.0,
        nudged: false,
        nudgeCount: 0,
      };
      this.state.set(sessionId, state);
    }
    return state;
  }

  /** Record a tool call into the rolling window. */
  record(sessionId: string, entry: ToolCallRecord): void {
    const state = this.get(sessionId);
    state.window.push(entry);

    // Enforce window size limit
    if (state.window.length > this.windowSize) {
      state.window.shift();
    }

    // Recompute score after each record
    state.score = computeScore(state.window);
  }

  /** Compute the current flailing score. */
  computeScore(sessionId: string): number {
    const state = this.get(sessionId);
    return state.score;
  }

  /** Mark that a nudge was injected. */
  markNudged(sessionId: string): void {
    const state = this.get(sessionId);
    state.nudged = true;
    state.nudgeCount++;
  }

  /** Reset state (e.g., on session_start or after successful escalation). */
  reset(sessionId: string): void {
    this.state.delete(sessionId);
  }

  /** Clear all state (for testing). */
  clear(): void {
    this.state.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FlailingTracker | null = null;

/** Get or create the global flailing tracker instance. */
export function getFlailingTracker(): FlailingTracker {
  if (!instance) {
    instance = new FlailingTracker();
  }
  return instance;
}

/** Replace the global instance (for testing). */
export function setFlailingTracker(tracker: FlailingTracker | null): void {
  instance = tracker;
}
