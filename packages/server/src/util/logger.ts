import pino from "pino";
import pretty from "pino-pretty";

const isTest = process.env.NODE_ENV === "test";

const logFile = Bun.env.MIMIR_LOG_FILE ?? (isTest ? "/tmp/mimir-test.log" : "/data/mimir.log");

const prettyStream = pretty({
  colorize: true,
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
});

const fileStream = pino.destination({
  dest: logFile,
  mkdir: true,
});

export const log = pino(
  { level: isTest ? "silent" : (Bun.env.LOG_LEVEL ?? "info") },
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
