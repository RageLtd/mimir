import pino from "pino";
import pretty from "pino-pretty";
import { REDACT_CENSOR, REDACT_PATHS } from "./redact";

const isTest = process.env.NODE_ENV === "test";

/** Where the JSON file log lands. Exported for the read_mimir_logs tool,
 *  which tails this file instead of shelling out to docker (MIM-68). */
export const LOG_FILE_PATH =
  Bun.env.MIMIR_LOG_FILE ??
  (isTest ? "/tmp/mimir-test.log" : "/data/mimir.log");

const prettyStream = pretty({
  colorize: true,
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
});

const fileStream = pino.destination({
  dest: LOG_FILE_PATH,
  mkdir: true,
});

export const log = pino(
  {
    level: isTest ? "silent" : (Bun.env.LOG_LEVEL ?? "info"),
    // BYOK key redaction (MIM-73) — paths defined in util/redact.ts, which
    // stays unmocked in tests (this module is preload-mocked wholesale).
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  },
  pino.multistream([
    { stream: prettyStream, level: "debug" },
    { stream: fileStream, level: "debug" },
  ]),
);

/** Create a child logger with a request correlation ID */
export function requestLog(requestId: string) {
  return log.child({ requestId });
}

export type Logger = pino.Logger;
