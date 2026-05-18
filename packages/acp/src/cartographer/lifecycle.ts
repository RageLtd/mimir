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

import { Glob } from "bun";
import { createChildLogger, log } from "../utils/log";
import {
  type CartographerClient,
  type ParsedFileOutput,
  spawnCartographer,
} from "./client";
import { syncIndex } from "./sync";

const logger = createChildLogger(log, "cartographer-lifecycle");

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mts,mjs,rs,go,py,rb,ex,exs}";
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "__pycache__",
]);

/** Tools that run locally via the cartographer binary. */
export const LOCAL_CARTOGRAPHER_TOOLS = new Set([
  "cartographer_index_project",
  "cartographer_detect_changes",
  "cartographer_parse_file",
]);

export const isLocalCartographerTool = (name: string) =>
  LOCAL_CARTOGRAPHER_TOOLS.has(name);

/** Tools that modify files on disk — used to detect when reindexing is needed. */
const FILE_WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "fs_write_text_file",
  "write_text_file",
]);

export const isFileWriteTool = (name: string) => FILE_WRITE_TOOLS.has(name);

const shouldIndexFile = (path: string) =>
  !path.split("/").some((part) => part.startsWith(".") || SKIP_DIRS.has(part));

const collectProjectFiles = async (projectPath: string) => {
  const glob = new Glob(SOURCE_GLOB);
  const files: string[] = [];
  for await (const match of glob.scan({ cwd: projectPath })) {
    if (shouldIndexFile(match)) {
      files.push(`${projectPath}/${match}`);
    }
  }
  return files;
};

export type CartographerManager = {
  /** Get or spawn the client for a project path. */
  readonly getClient: (projectPath: string) => Promise<CartographerClient>;
  /** Execute a local cartographer tool call. Returns the text result. */
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  /**
   * Trigger an auto-index for a project (fire-and-forget). The optional
   * `getProjectId` accessor is called at sync time — the resolver may have
   * completed between this invocation and the actual HTTP call, so we read
   * the latest value rather than capturing a potentially null snapshot.
   */
  readonly autoIndex: (
    projectPath: string,
    getProjectId?: () => string | null,
  ) => void;
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
) => {
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

  const autoIndex = (
    projectPath: string,
    getProjectId?: () => string | null,
  ) => {
    // In --parse-only mode the binary has no DB access, and its full-index
    // tool returns a human summary. ACP owns the persisted index payload by
    // walking source files, parsing each one locally, and syncing the results.
    getClient(projectPath)
      .then(async (client) => {
        logger.info("auto-indexing project:", projectPath);
        const filePaths = await collectProjectFiles(projectPath);
        const parsedFiles: ParsedFileOutput[] = [];

        for (const filePath of filePaths) {
          const parsed = await client.parseFile(projectPath, filePath).then(
            (result) => ({ data: result, error: null }),
            (error) => ({ data: null, error }),
          );
          if (parsed.data) {
            parsedFiles.push(parsed.data);
          } else {
            logger.debug("cartographer skipped file:", filePath, parsed.error);
          }
        }

        if (parsedFiles.length === 0) {
          logger.warn("cartographer parsed no files for:", projectPath);
          return;
        }

        await syncIndex(
          { serverUrl: config.serverUrl, apiKey: config.apiKey, logger },
          projectPath,
          parsedFiles,
          getProjectId?.() ?? null,
        );
      })
      .catch((err) => {
        logger.warn("auto-index failed:", err);
      });
  };

  const dispose = () => {
    for (const [path, client] of clients) {
      logger.info("killing cartographer for:", path);
      client.kill();
    }
    clients.clear();
    spawning.clear();
  };

  return { getClient, executeTool, autoIndex, dispose };
};
