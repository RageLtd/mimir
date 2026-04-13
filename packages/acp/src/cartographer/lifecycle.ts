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
import { syncIndex } from "./sync";

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
  /** Environment variables to pass to the binary. */
  readonly env?: Record<string, string>;
  /** mimir-server URL for syncing the parsed index. */
  readonly serverUrl: string;
  /** API key for mimir-server. */
  readonly apiKey: string;
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
    // In --parse-only mode the binary has no DB access; it returns the
    // full index as JSON via the MCP tool result. We forward that JSON
    // directly to mimir-server's sync endpoint.
    getClient(projectPath)
      .then(async (client) => {
        logger.info("auto-indexing project:", projectPath);
        const rawJson = await client.indexProject(projectPath);
        if (!rawJson || rawJson.trim() === "") {
          logger.warn("cartographer returned empty index for:", projectPath);
          return;
        }
        await syncIndex(
          { serverUrl: config.serverUrl, apiKey: config.apiKey, logger },
          rawJson,
        );
      })
      .catch((err) => {
        logger.warn("auto-index failed:", err);
      });
  };

  const detectChanges = (projectPath: string): void => {
    // detect_changes returns a summary of what changed, not the full index.
    // If anything changed, trigger a full re-index and sync so the server
    // stays in step.
    getClient(projectPath)
      .then(async (client) => {
        const result = await client.detectChanges(projectPath);
        if (result.indexed > 0 || result.removed > 0) {
          logger.info(
            "changes detected:",
            result.indexed,
            "indexed,",
            result.removed,
            "removed — re-syncing index",
          );
          const rawJson = await client.indexProject(projectPath);
          if (rawJson && rawJson.trim() !== "") {
            await syncIndex(
              { serverUrl: config.serverUrl, apiKey: config.apiKey, logger },
              rawJson,
            );
          }
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
