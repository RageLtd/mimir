/**
 * File-based logger for Mimir's plugin adapters.
 *
 * Writes structured log lines to `~/.mimir/logs/<fileName>`, append-only.
 * The factory pattern lets each consumer (CC plugin, future OC plugin)
 * bind its own filenames while sharing the same log-level and format
 * logic, and gives each factory its own rotation + pending-write chain
 * so concurrent consumers in the same process don't interfere.
 *
 * Each consumer wraps the factory once in its own `src/logger.ts`:
 *
 *   import { createLoggerFactory } from "@mimir/plugin-core/logger";
 *   const { createLogger, flushLogs } = createLoggerFactory(
 *     "mimir-cc.log",
 *     "mimir-cc.prev.log",
 *   );
 *   export { createLogger, flushLogs };
 *
 * Downstream code then does `createLogger("voice-anchor")` and the
 * factory takes care of writing to the right file. The consumer's
 * `cli.ts` calls `flushLogs()` before `process.exit()` to guarantee the
 * most recent line (usually the one explaining the exit) lands on disk.
 *
 * Log level is INFO by default; set MIMIR_DEBUG=1 to enable DEBUG.
 *
 * Format: `<ISO timestamp> [<level>] <component>: <message> <json-context?>`
 * One line per call. Context is appended as compact JSON when present.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { mimirHome } from "./util";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Log level is a process-wide concern, not a per-factory one — every
// consumer in the same process should log at the same level, controlled
// by the same env var.
const currentLevel: LogLevel =
  process.env.MIMIR_DEBUG === "1" ? "debug" : "info";
const minPriority = LEVEL_PRIORITY[currentLevel];

export type Logger = {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
};

export type LoggerBundle = {
  readonly createLogger: (component: string) => Logger;
  readonly flushLogs: () => Promise<void>;
};

/**
 * Render the optional context payload. JSON.stringify can throw on
 * circular references; we let the throw propagate up to the writeLine
 * promise chain, which catches it into a no-op. The result is one
 * dropped log line — acceptable trade-off vs. a try/catch here.
 */
const formatContext = (context: unknown): string => {
  if (context === undefined) return "";
  if (context instanceof Error) {
    return ` ${JSON.stringify({ error: context.message, stack: context.stack })}`;
  }
  return ` ${JSON.stringify(context)}`;
};

const formatLine = (
  level: LogLevel,
  component: string,
  message: string,
  context: unknown,
) =>
  `${new Date().toISOString()} [${level.toUpperCase()}] ${component}: ${message}${formatContext(context)}\n`;

// Rotation policy: a log rotates when it was last written on a previous
// calendar day (local time) or has grown past the size cap. Rotating on
// every factory instantiation — the old behavior — meant every HOOK
// PROCESS rotated the file, so only the last two hook invocations of a
// session survived and post-hoc debugging of a multi-hook turn was blind.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Pure rotation decision — exported for tests. */
export const shouldRotate = (
  fileStats: { readonly mtimeMs: number; readonly size: number },
  nowMs: number,
  maxBytes: number = MAX_LOG_BYTES,
) => {
  if (fileStats.size >= maxBytes) return true;
  return !sameLocalDay(new Date(fileStats.mtimeMs), new Date(nowMs));
};

/**
 * Create a logger bundle bound to a specific log file.
 *
 * Each factory instance owns its own pending-write chain, so multiple
 * consumers in the same process don't interleave partially written
 * lines. The default prev file name is `<fileName>.prev` — pass an
 * explicit one if the consumer wants a different suffix convention.
 */
export const createLoggerFactory = (
  fileName: string,
  prevFileName?: string,
) => {
  const prevName = prevFileName ?? `${fileName}.prev`;

  // ── Lazy sink + pending-write chain ──
  // Path resolution and the mkdir/rotate init are deferred to the FIRST
  // write, not factory creation. Factories are created at module import
  // time (each hook module does `createLogger(...)` at top level), which
  // runs before test suites can point MIMIR_HOME at a sandbox — eager
  // paths made test-suite log lines land in the developer's real
  // ~/.mimir/logs. Every writeLine appends onto the sink's `pending`
  // chain; the first link mkdir's the log directory and rotates ONLY
  // when the policy says so (new day / size cap). Failures anywhere are
  // absorbed into a no-op so the chain never enters a rejected state.
  type LogSink = { readonly logPath: string; pending: Promise<void> };
  let sink: LogSink | null = null;

  const ensureSink = () => {
    if (sink) return sink;
    const logPath = join(mimirHome(), "logs", fileName);
    const prevPath = join(mimirHome(), "logs", prevName);
    const pending: Promise<void> = mkdir(dirname(logPath), {
      recursive: true,
    })
      .then(() => stat(logPath))
      .then((stats) =>
        shouldRotate(stats, Date.now())
          ? rename(logPath, prevPath).catch(() => undefined)
          : undefined,
      )
      .then(() => undefined)
      .catch(() => undefined);
    sink = { logPath, pending };
    return sink;
  };

  const writeLine = (line: string) => {
    const active = ensureSink();
    active.pending = active.pending
      .then(() => appendFile(active.logPath, line))
      .catch(() => undefined);
  };

  const createLogger = (component: string): Logger => {
    const log = (level: LogLevel, message: string, context?: unknown) => {
      if (LEVEL_PRIORITY[level] < minPriority) return;
      writeLine(formatLine(level, component, message, context));
    };

    return {
      debug: (message, context) => log("debug", message, context),
      info: (message, context) => log("info", message, context),
      warn: (message, context) => log("warn", message, context),
      error: (message, context) => log("error", message, context),
    };
  };

  return {
    createLogger,
    // Nothing written yet → nothing to flush; don't create the sink
    // (and its mkdir) just to await it.
    flushLogs: () => sink?.pending ?? Promise.resolve(),
  };
};
