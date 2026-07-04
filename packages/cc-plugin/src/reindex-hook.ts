/**
 * Cartographer auto-reindex PostToolUse hook.
 *
 * Wired into ~/.mimir/settings.json as a PostToolUse hook on Edit, Write,
 * and MultiEdit. CC fires us with the tool payload on stdin; we extract
 * the file path, spawn a detached `reindex --worker` child to do the
 * actual parse + server sync, and exit immediately so CC's next model
 * turn isn't blocked on a Rust binary plus an HTTP round-trip.
 *
 * The worker mode (`mimir-cc reindex --worker <project> <file>`) is the
 * one that actually spawns cartographer, parses the file, and POSTs to
 * mimir-server. Detaching from the hook process means CC sees a clean
 * exit code 0 immediately while the indexer keeps running in the
 * background.
 *
 * No-op when MIMIR_ACTIVE != 1 (defence in depth — settings.json scoping
 * already restricts the hook to mimir sessions), when the tool isn't a
 * file-write, when there's no cartographer binary configured, or when
 * the file path can't be resolved from the tool input.
 */

import { spawn } from "node:child_process";
import { readConfig } from "./config";
import { createLogger } from "./logger";
import { getOrResolveProjectId, toProjectRelative } from "./project";
import { errMessage } from "./util";

const log = createLogger("reindex-hook");

const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  return buf.toString("utf8");
};

const safeParseHookInput = (raw: string): HookInput => {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
};

/**
 * Extract the file_path field from the hook's tool_input. All three
 * supported tools (Edit/Write/MultiEdit) carry `file_path` as a top-level
 * string — MultiEdit's per-edit objects don't.
 */
const extractFilePath = (input: HookInput): string | null => {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return null;
  const fp = (ti as Record<string, unknown>).file_path;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
};

/**
 * Fork a detached child running `mimir-cc reindex --worker <project> <file>`.
 *
 * `process.execPath` resolves to the running binary (mimir-cc itself when
 * invoked via the wrapper, bun in dev mode — dev runs are blocked
 * upstream by MIMIR_ACTIVE). `detached: true` + `stdio: "ignore"` + a
 * call to `child.unref()` lets the parent exit while the worker keeps
 * running until its own work is done.
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
 * Hook entry — fast path. Reads stdin, validates the tool name + file
 * path, spawns the worker, exits 0. All work after this returns to CC's
 * next model turn immediately.
 */
const runHook = async (): Promise<number> => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = safeParseHookInput(raw);

  if (!input.tool_name || !FILE_WRITE_TOOLS.has(input.tool_name)) return 0;

  const filePath = extractFilePath(input);
  if (!filePath) return 0;

  const projectPath = input.cwd ?? process.cwd();

  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.debug("no cartographer binary configured — skipping reindex", {
      filePath,
    });
    return 0;
  }

  log.info("spawning reindex worker", {
    tool: input.tool_name,
    filePath,
    projectPath,
  });
  spawnWorker(projectPath, filePath);
  return 0;
};

/**
 * Worker mode — does the actual parse + sync. Long-running. Exits when
 * the work completes (or after the cartographer spawn fails, which we
 * log but don't propagate).
 */
const runWorker = async (
  projectPath: string,
  filePath: string,
): Promise<number> => {
  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.warn("worker started but no cartographer configured", { filePath });
    return 0;
  }

  const { spawnCartographer } = await import("./cartographer/client");
  const { syncIndex } = await import("./cartographer/sync");

  const client = await spawnCartographer(
    config.cartographerBinary,
    projectPath,
  ).catch((err) => {
    log.error("cartographer spawn failed", { error: errMessage(err) });
    return null;
  });
  if (!client) return 0;

  // tool_input.file_path comes through as an absolute path from CC. The
  // cart_file row needs to land under the canonical relative form so
  // dependents queries can match across the session-start and reindex
  // paths — see Slice 1 plan, "Path representation".
  const relativePath = toProjectRelative(projectPath, filePath);
  const parsed = await client
    .parseFile(projectPath, relativePath)
    .catch((err) => {
      log.error("parseFile failed", { filePath, error: errMessage(err) });
      return null;
    });
  client.kill();
  if (!parsed) return 0;

  // Resolve the project to a UUID. On cache hit this is a single disk
  // read with no HTTP; on miss it falls back to keying by rootPath when
  // the resolver is unreachable.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
  ).catch(() => null);

  // Single-file reindex MUST use upsert mode — replace mode would wipe
  // the project's entire cart_file/cart_import index on every Edit and
  // leave only the one file we just parsed. The SessionStart hook owns
  // full-project replace.
  // Env wins over config.json — same precedence as authHeaders (MIM-77).
  const apiKey = process.env.MIMIR_API_KEY ?? config.apiKey;
  const result = await syncIndex(
    { serverUrl: config.serverUrl, ...(apiKey ? { apiKey } : {}) },
    projectPath,
    [parsed],
    projectId,
    "upsert",
  );
  if (!result.ok) {
    log.error("syncIndex returned !ok", { filePath, error: result.error });
  }
  return 0;
};

/**
 * Subcommand dispatcher used by cli.ts. argv after `reindex` is one of:
 *   (nothing)                       — hook mode (read stdin, fork worker)
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
