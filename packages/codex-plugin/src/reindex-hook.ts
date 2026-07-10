/**
 * Cartographer auto-reindex PostToolUse hook (ported from cc-plugin).
 *
 * Wired as a PostToolUse hook matched on apply_patch — Codex's single
 * edit tool. The patch document names every touched file, so one hook
 * firing can fan out to several reindex workers (one per written file;
 * deletes are handled by the next session-start full replace).
 *
 * The worker mode (`mimir-codex-bin reindex --worker <project> <file>`)
 * spawns cartographer, parses the file, and upserts the result into the
 * local cart index (MIM-91 — nothing leaves the machine). Detaching from
 * the hook process means Codex sees a clean exit code 0 immediately
 * while the indexer keeps running in the background.
 */

import { spawn } from "node:child_process";
import { toProjectRelative } from "@mimir/plugin-core/project";
import { readConfig } from "@mimir/plugin-core/shared-config";
import { errMessage } from "@mimir/plugin-core/util";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";
import { editedFilePaths } from "./tool-map";

const log = createLogger("reindex-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

/**
 * Fork a detached child per file running
 * `mimir-codex-bin reindex --worker <project> <file>`.
 */
const spawnWorker = (projectPath: string, filePath: string) => {
  const child = spawn(
    process.execPath,
    ["reindex", "--worker", projectPath, filePath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
};

/**
 * Hook entry — fast path. Reads stdin, extracts written paths from the
 * patch, spawns workers, exits 0.
 */
const runHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();
  if (!input.tool_name) return 0;

  const filePaths = editedFilePaths(input.tool_name, input.tool_input);
  if (filePaths.length === 0) return 0;

  const projectPath = input.cwd ?? process.cwd();

  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.debug("no cartographer binary configured — skipping reindex", {
      filePaths,
    });
    return 0;
  }

  log.info("spawning reindex workers", {
    tool: input.tool_name,
    filePaths,
    projectPath,
  });
  for (const filePath of filePaths) {
    spawnWorker(projectPath, filePath);
  }
  return 0;
};

/**
 * Worker mode — does the actual parse + sync. Long-running. Exits when
 * the work completes (or after the cartographer spawn fails, which we
 * log but don't propagate).
 */
const runWorker = async (projectPath: string, filePath: string) => {
  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.warn("worker started but no cartographer configured", { filePath });
    return 0;
  }

  const { spawnCartographer } = await import(
    "@mimir/plugin-core/cartographer/client"
  );
  const { syncIndex } = await import("@mimir/plugin-core/cartographer/sync");

  const client = await spawnCartographer(
    config.cartographerBinary,
    projectPath,
  ).catch((err) => {
    log.error("cartographer spawn failed", { error: errMessage(err) });
    return null;
  });
  if (!client) return 0;

  // apply_patch headers carry absolute paths; the cart_file row needs the
  // canonical project-relative form so dependents queries match across
  // the session-start and reindex paths.
  const relativePath = toProjectRelative(projectPath, filePath);
  const parsed = await client
    .parseFile(projectPath, relativePath)
    .catch((err) => {
      log.error("parseFile failed", { filePath, error: errMessage(err) });
      return null;
    });
  client.kill();
  if (!parsed) return 0;

  // Single-file reindex MUST use upsert mode — replace mode would wipe
  // the project's entire local index on every edit. The SessionStart
  // hook owns full-project replace.
  const result = await syncIndex(projectPath, [parsed], "upsert");
  if (!result.ok) {
    log.error("syncIndex returned !ok", { filePath, error: result.error });
  }
  return 0;
};

/**
 * Subcommand dispatcher used by cli.ts. argv after `reindex` is one of:
 *   (nothing)                       — hook mode (read stdin, fork workers)
 *   --worker <project> <file>       — worker mode (do the parse + sync)
 */
export const runReindexCommand = async (args: readonly string[]) => {
  if (args[0] === "--worker") {
    const projectPath = args[1];
    const filePath = args[2];
    if (!projectPath || !filePath) {
      log.error("worker missing args", { args });
      return 1;
    }
    return runWorker(projectPath, filePath);
  }
  return runHook();
};
