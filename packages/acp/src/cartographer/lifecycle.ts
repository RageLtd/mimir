/**
 * Cartographer lifecycle management.
 *
 * Manages the cartographer binary's lifecycle: spawn on session create,
 * auto-index the project, detect changes incrementally, and clean up
 * on dispose.
 *
 * Tool classification:
 *   Local (run by mimir-acp via the binary):
 *     - cartographer_index_project
 *     - cartographer_detect_changes
 *     - cartographer_parse_file
 *
 *   Server (already on mimir-server, queried remotely):
 *     - cartographer_query
 *     - cartographer_search
 *     - cartographer_get_file_info
 *     - cartographer_find_cycles
 *     - cartographer_stats
 */

import { createChildLogger, log } from "../utils/log";
import { type CartographerClient, spawnCartographer } from "./client";

const logger = createChildLogger(log, "cartographer-lifecycle");

/** Tools that run locally via the cartographer binary. */
export const LOCAL_CARTOGRAPHER_TOOLS = new Set([
  "cartographer_index_project",
  "cartographer_detect_changes",
  "cartographer_parse_file",
]);

export const isLocalCartographerTool = (name: string): boolean =>
  LOCAL_CARTOGRAPHER_TOOLS.has(name);

export type CartographerManager = {
  /** Get or spawn the client for a project path. */
  readonly getClient: (projectPath: string) => Promise<CartographerClient>;
  /** Execute a local cartographer tool call. Returns the text result. */
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  /** Trigger an auto-index for a project (fire-and-forget). */
  readonly autoIndex: (projectPath: string) => void;
  /** Trigger incremental change detection (fire-and-forget). */
  readonly detectChanges: (projectPath: string) => void;
  /** Kill all child processes. */
  readonly dispose: () => void;
};

export type CartographerManagerConfig = {
  /** Path to the cartographer binary. */
  readonly binaryPath: string;
  /** Environment variables to pass to the binary (e.g. SURREAL_URL). */
  readonly env?: Record<string, string>;
};

export const createCartographerManager = (
  config: CartographerManagerConfig,
): CartographerManager => {
  // One client per project path (each binary instance gets its own cwd)
  const clients = new Map<string, CartographerClient>();
  const spawning = new Map<string, Promise<CartographerClient>>();

  const getClient = async (
    projectPath: string,
  ): Promise<CartographerClient> => {
    const existing = clients.get(projectPath);
    if (existing?.isAlive()) return existing;

    // Avoid double-spawning
    const inflight = spawning.get(projectPath);
    if (inflight) return inflight;

    const promise = spawnCartographer(
      config.binaryPath,
      projectPath,
      config.env,
    ).then((client) => {
      clients.set(projectPath, client);
      spawning.delete(projectPath);
      return client;
    });

    spawning.set(projectPath, promise);
    return promise;
  };

  const executeTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const project = (args.project ?? args.projectPath) as string | undefined;
    if (!project) {
      return "Error: project path is required for cartographer tools.";
    }

    const client = await getClient(project);
    return client.callTool(name, args);
  };

  const autoIndex = (projectPath: string): void => {
    // The binary auto-indexes CWD on startup, so just ensuring the
    // client is spawned triggers indexing. If already running, call
    // index_project explicitly.
    getClient(projectPath)
      .then(async (client) => {
        // If client was already alive, trigger explicit index
        const stats = await client.stats(projectPath).catch(() => null);
        if (stats && stats.totalFiles === 0) {
          logger.info("auto-indexing project:", projectPath);
          await client.indexProject(projectPath);
        } else {
          logger.info(
            "cartographer already indexed:",
            projectPath,
            stats ? `(${stats.totalFiles} files)` : "",
          );
        }
      })
      .catch((err) => {
        logger.warn("auto-index failed:", err);
      });
  };

  const detectChanges = (projectPath: string): void => {
    getClient(projectPath)
      .then(async (client) => {
        const result = await client.detectChanges(projectPath);
        if (result.indexed > 0 || result.removed > 0) {
          logger.info(
            "changes detected:",
            result.indexed,
            "indexed,",
            result.removed,
            "removed",
          );
        }
      })
      .catch((err) => {
        logger.warn("detect-changes failed:", err);
      });
  };

  const dispose = (): void => {
    for (const [path, client] of clients) {
      logger.info("killing cartographer for:", path);
      client.kill();
    }
    clients.clear();
    spawning.clear();
  };

  return { getClient, executeTool, autoIndex, detectChanges, dispose };
};
