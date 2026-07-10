/**
 * codex-plugin logger — binds the shared factory to mimir-codex.log so
 * every hook and command in this distribution writes to the same file,
 * separate from mimir-cc.log / mimir-oc.log.
 */

import { createLoggerFactory } from "@mimir/plugin-core/logger";

const { createLogger, flushLogs } = createLoggerFactory(
  "mimir-codex.log",
  "mimir-codex.prev.log",
);

export { createLogger, flushLogs };
