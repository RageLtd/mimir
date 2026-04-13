/**
 * Structured logging — plain functions, no class.
 *
 * Lazy initialization to avoid circular imports with config.
 * The first call to getLogger() resolves the log level from config.
 */

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

export const createLogger = (level: LogLevel): Logger => {
  const shouldLog = (msgLevel: LogLevel): boolean =>
    LEVELS[msgLevel] >= LEVELS[level];

  const log =
    (msgLevel: LogLevel, prefix: string) =>
    (...args: unknown[]) => {
      if (shouldLog(msgLevel)) {
        const ts = new Date().toISOString();
        console.error(`[${ts}] [${msgLevel.toUpperCase()}] ${prefix}`, ...args);
      }
    };

  return {
    debug: log("debug", "mimir-acp"),
    info: log("info", "mimir-acp"),
    warn: log("warn", "mimir-acp"),
    error: log("error", "mimir-acp"),
  };
};

export const createChildLogger = (parent: Logger, prefix: string): Logger => ({
  debug: (...args: unknown[]) => parent.debug(`[${prefix}]`, ...args),
  info: (...args: unknown[]) => parent.info(`[${prefix}]`, ...args),
  warn: (...args: unknown[]) => parent.warn(`[${prefix}]`, ...args),
  error: (...args: unknown[]) => parent.error(`[${prefix}]`, ...args),
});

let _logger: Logger | null = null;

/** Lazily-initialized root logger using config.logLevel. */
export const getLogger = (): Logger => {
  if (!_logger) {
    _logger = createLogger(config.logLevel);
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
