/**
 * Test setup — mocks for modules with side effects.
 * Loaded via bunfig.toml [test].preload before any test file.
 */

import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger — pino tries to mkdir /data and open a file stream on import.
// Replace with silent no-ops.
// ---------------------------------------------------------------------------

const noop = () => {};
const noopLogger: Record<string, unknown> = {
  info: noop,
  debug: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  trace: noop,
  level: "silent",
};
noopLogger.child = () => noopLogger;

mock.module("../src/util/logger", () => ({
  log: noopLogger,
  requestLog: () => noopLogger,
}));
