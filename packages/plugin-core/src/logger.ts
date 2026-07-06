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

import { appendFile, mkdir, rename } from "node:fs/promises";
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

/**
 * Create a logger bundle bound to a specific log file.
 *
 * Each factory instance owns its own rotation state and pending-write
 * chain, so multiple consumers in the same process (or the same
 * consumer running as several subprocesses that share a node_modules
 * cache) don't write to each other's files. The default prev file
 * name is `<fileName>.prev` — pass an explicit one if the consumer
 * wants a different suffix convention.
 */
export const createLoggerFactory = (
  fileName: string,
  prevFileName?: string,
): LoggerBundle => {
  const prevName = prevFileName ?? `${fileName}.prev`;

  const logPath = join(mimirHome(), "logs", fileName);
  const prevPath = join(mimirHome(), "logs", prevName);

  // ── Pending-write chain ──
  // Every writeLine call appends onto `pending`. The first link mkdir's the
  // log directory, rotates the previous log, then subsequent links append
  // text. Failures at any step are absorbed into a no-op so the chain
  // never enters a rejected state.
  let pending: Promise<void> = mkdir(dirname(logPath), { recursive: true })
    .then(() => rename(logPath, prevPath).catch(() => undefined))
    .then(() => undefined)
    .catch(() => undefined);

  const writeLine = (line: string) => {
    pending = pending
      .then(() => appendFile(logPath, line))
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
    flushLogs: () => pending,
  };
};
