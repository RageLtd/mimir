/**
 * CC plugin logger — binds the shared logger factory from
 * @mimir/plugin-core to `mimir-cc.log` and `mimir-cc.prev.log` under
 * `~/.mimir/logs/`.
 *
 * Every hook imports `createLogger` from this local wrapper and calls
 * `createLogger("<component>")`; the factory takes care of writing to
 * the right file. `flushLogs` is re-exported so `cli.ts` can drain
 * pending writes before `process.exit()`.
 *
 * The future oc-plugin will have its own thin wrapper here, bound to
 * `mimir-oc.log` and `mimir-oc.prev.log`. The shared layer stays
 * host-agnostic — it knows about log file paths, not about which
 * adapter wrote them.
 */

import { createLoggerFactory } from "@mimir/plugin-core/logger";

const { createLogger, flushLogs } = createLoggerFactory(
  "mimir-cc.log",
  "mimir-cc.prev.log",
);

export { createLogger, flushLogs };
