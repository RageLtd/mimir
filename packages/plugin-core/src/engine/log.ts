/**
 * Engine log seam.
 *
 * The engine (provider registry, turn streaming) runs inside long-lived
 * client processes — the ACP agent today, others later. Each consumer has
 * its own log file, so the engine writes to its own factory-bound file by
 * default (`~/.mimir/logs/mimir-engine.log`) and exposes `setEngineLogger`
 * for a host that wants engine lines interleaved into its own log.
 *
 * The indirection exists because the moved server modules logged through
 * pino at module level — threading a logger parameter through every query
 * helper would have reshaped call sites for no behavioral gain.
 */

import { createLoggerFactory, type Logger } from "../logger";

const { createLogger, flushLogs } = createLoggerFactory("mimir-engine.log");

let activeLogger: Logger = createLogger("engine");

/** Redirect engine logging into the host's own logger. */
export const setEngineLogger = (logger: Logger) => {
  activeLogger = logger;
};

export const flushEngineLogs = flushLogs;

/** Stable facade — call sites keep working when the host swaps the sink. */
export const log: Logger = {
  debug: (message, context) => activeLogger.debug(message, context),
  info: (message, context) => activeLogger.info(message, context),
  warn: (message, context) => activeLogger.warn(message, context),
  error: (message, context) => activeLogger.error(message, context),
};
