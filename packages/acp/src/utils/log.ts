/**
 * Structured logging — plain functions, no class.
 *
 * Lazy initialization to avoid circular imports with config.
 * The first call to getLogger() resolves the log level from config.
 *
 * Two sinks: stderr (always) and an optional append-mode file at
 * `config.acpLogPath`. Stdout is reserved for the ACP NDJSON protocol —
 * never write log output there. The file sink is best-effort: if the
 * stream's lazy open fails, the error event handler disables further
 * file writes and surfaces a one-shot stderr notice so the developer
 * knows file logging is off without spamming on every subsequent log
 * call.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { format } from "node:util";

import { config } from "../config";

type LogLevel = (typeof config)["logLevel"];

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

let _fileStream: ReturnType<typeof createWriteStream> | null = null;
let _fileStreamFailed = false;

/**
 * Lazily open the append-mode log file stream. `createWriteStream` is
 * itself lazy — it surfaces open failures via the `'error'` event rather
 * than throwing synchronously, so the error handler is the right seam
 * for "file logging unavailable." Marks the stream permanently disabled
 * on first failure to prevent repeated stderr noise.
 */
const getFileStream = (path: string) => {
  if (_fileStreamFailed) return null;
  if (_fileStream) return _fileStream;

  // Best-effort parent dir creation. mkdir errors land in stderr — if the
  // directory truly can't exist, the createWriteStream error handler below
  // will report the file open failure separately. Logging here makes the
  // failure mode visible rather than silently swallowed.
  void mkdir(dirname(path), { recursive: true }).catch((err) => {
    process.stderr.write(
      `[mimir-acp] log dir ${dirname(path)} mkdir failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });

  const stream = createWriteStream(path, { flags: "a" });
  stream.on("error", (err) => {
    _fileStreamFailed = true;
    _fileStream = null;
    process.stderr.write(
      `[mimir-acp] log file ${path} failed: ${err.message}\n`,
    );
  });
  _fileStream = stream;

  // Banner identifies this process when multiple ACP instances share the file.
  const ts = new Date().toISOString();
  stream.write(
    `[${ts}] [INFO] mimir-acp [log] === session started — pid=${process.pid} cwd=${process.cwd()} ===\n`,
  );
  return stream;
};

/**
 * Format args the way `console.error` would, into a single line ending in \n.
 * Mirrors what would land on stderr so the file copy is identical. `util.format`
 * is what Node's console uses internally — handles circular refs, errors,
 * primitives, and `%s`/`%o`/`%j` substitutions without throwing.
 */
const formatLine = (
  msgLevel: LogLevel,
  prefix: string,
  args: readonly unknown[],
) => {
  const ts = new Date().toISOString();
  const body = args.length > 0 ? ` ${format(...args)}` : "";
  return `[${ts}] [${msgLevel.toUpperCase()}] ${prefix}${body}\n`;
};

export const createLogger = (
  level: LogLevel,
  filePath: string = config.acpLogPath,
) => {
  const shouldLog = (msgLevel: LogLevel) => LEVELS[msgLevel] >= LEVELS[level];

  const log =
    (msgLevel: LogLevel, prefix: string) =>
    (...args: unknown[]) => {
      if (!shouldLog(msgLevel)) return;
      const line = formatLine(msgLevel, prefix, args);
      process.stderr.write(line);
      if (filePath.length > 0) {
        const stream = getFileStream(filePath);
        if (stream) stream.write(line);
      }
    };

  const logger: Logger = {
    debug: log("debug", "mimir-acp"),
    info: log("info", "mimir-acp"),
    warn: log("warn", "mimir-acp"),
    error: log("error", "mimir-acp"),
  };
  return logger;
};

export const createChildLogger = (parent: Logger, prefix: string) => {
  const child: Logger = {
    debug: (...args: unknown[]) => parent.debug(`[${prefix}]`, ...args),
    info: (...args: unknown[]) => parent.info(`[${prefix}]`, ...args),
    warn: (...args: unknown[]) => parent.warn(`[${prefix}]`, ...args),
    error: (...args: unknown[]) => parent.error(`[${prefix}]`, ...args),
  };
  return child;
};

let _logger: Logger | null = null;

/** Lazily-initialized root logger using config.logLevel. */
export const getLogger = () => {
  if (!_logger) {
    _logger = createLogger(config.logLevel, config.acpLogPath);
  }
  return _logger;
};

/** Convenience accessor — resolves the lazy logger on each call. */
export const log: Logger = {
  debug: (...args: unknown[]) => getLogger().debug(...args),
  info: (...args: unknown[]) => getLogger().info(...args),
  warn: (...args: unknown[]) => getLogger().warn(...args),
  error: (...args: unknown[]) => getLogger().error(...args),
};
