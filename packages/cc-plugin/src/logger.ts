/**
 * File-based logger for the mimir-cc runtime.
 *
 * Writes structured log lines to `~/.mimir/logs/mimir-cc.log`, append-only.
 * Hooks run as short-lived subprocesses with stdin/stdout reserved for the
 * CC hook protocol, so anything chatty has to go somewhere durable — the
 * developer can `tail -f` this file to debug rule misfires, reindex
 * failures, or boot-context assembly errors.
 *
 * Log level is INFO by default; set MIMIR_DEBUG=1 to enable DEBUG.
 *
 * The logger is fire-and-forget at the call site (sync-looking API) but
 * every write chains onto a module-local Promise so cli.ts can
 * `await flushLogs()` before `process.exit()` and guarantee the most
 * recent lines actually hit disk. Errors anywhere in the chain are
 * absorbed via `.catch(() => undefined)` — log infrastructure should
 * never take down a hook, and chaining `.catch` keeps us out of
 * try/catch for control flow.
 *
 * Format: `<ISO timestamp> [<level>] <component>: <message> <json-context?>`
 * One line per call. Context is appended as compact JSON when present.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { mimirHome } from "./util";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel: LogLevel =
  process.env.MIMIR_DEBUG === "1" ? "debug" : "info";

const minPriority = LEVEL_PRIORITY[currentLevel];

const logPath = () => join(mimirHome(), "logs", "mimir-cc.log");

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

// ── Pending-write chain ──
// Every writeLine call appends onto `pending`. The first link mkdir's the
// log directory; subsequent links append text. Failures at any step are
// absorbed into a no-op so the chain never enters a rejected state.

let pending: Promise<void> = mkdir(dirname(logPath()), { recursive: true })
  .then(() => undefined)
  .catch(() => undefined);

const writeLine = (line: string) => {
  pending = pending
    .then(() => appendFile(logPath(), line))
    .catch(() => undefined);
};

/**
 * Wait for every pending log write to flush to disk. Called from cli.ts
 * immediately before `process.exit()` so the last log line — usually the
 * one that explains why the hook is exiting — actually lands.
 */
export const flushLogs = () => pending;

export type Logger = {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
};

export const createLogger = (component: string): Logger => {
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
