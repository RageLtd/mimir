/**
 * Cartographer reindex workers for the OpenCode plugin.
 *
 * Two detached, short-lived flows: `runReindexWorker` reparses a single
 * edited file (driven by the `file.edited` event); `runFullReindex` walks
 * every git-tracked file at session start and syncs them as one
 * replace-mode payload. The parse-and-write loop is plugin-core's
 * (`cartographer/reindex`); these bind it to OpenCode's config and log.
 *
 * Extracted from index.ts to keep the plugin entry under the file-length
 * limit; the entry wires these to events and owns the fire-and-forget
 * `.catch()`.
 */

import {
  reindexFile,
  reindexProject,
} from "@mimir/plugin-core/cartographer/reindex";
import type { Logger } from "@mimir/plugin-core/logger";
import type { MimirConfig } from "./config";

/**
 * Reparse a single edited file and upsert it into the index. Skips
 * silently when no cartographer binary is configured. The path is passed
 * to cartographer as given.
 */
export const runReindexWorker = async (
  log: Logger,
  config: MimirConfig,
  projectPath: string,
  filePath: string,
) => {
  const outcome = await reindexFile({
    projectPath,
    filePath,
    cartographerBinary: config.cartographerBinary,
    log,
  });
  if (outcome.status === "unconfigured") {
    log.debug("no cartographer binary configured — skipping reindex", {
      filePath,
    });
  }
};

/**
 * Full project reindex: walk every git-tracked source file, parse each,
 * sync as a single replace-mode payload.
 */
export const runFullReindex = async (
  log: Logger,
  config: MimirConfig,
  projectPath: string,
) => {
  const outcome = await reindexProject({
    projectPath,
    cartographerBinary: config.cartographerBinary,
    log,
  });
  switch (outcome.status) {
    case "unconfigured":
      log.debug("no cartographer binary configured — skipping full reindex");
      return;
    case "synced":
      log.info("session-start reindex complete", {
        fileCount: outcome.attempted,
        parsed: outcome.parsed,
        syncOk: outcome.syncOk,
      });
      return;
    case "no-files":
    case "spawn-failed":
    case "nothing-parsed":
      // Already logged by reindexProject.
      return;
    default:
      return assertNever(outcome);
  }
};

const assertNever = (value: never) => {
  throw new Error(`unhandled reindex outcome: ${JSON.stringify(value)}`);
};
