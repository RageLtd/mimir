/**
 * Cartographer reindex — the parse-and-write loop every host runs.
 *
 * `reindexProject` lists the project's files, parses each through one
 * cartographer process and writes them with `mode: "replace"`, so
 * anything deleted or moved since the last full scan drops out.
 * `reindexFile` parses one file and writes it with `mode: "upsert"` —
 * replace there would wipe the project's index down to that one file.
 *
 * Both return an outcome rather than logging a summary: the host owns
 * when it runs, how it is scheduled, and what it reports. Failure detail
 * (spawn, parse, write) is logged here through the host's `log`.
 */

import type { Logger } from "../logger";
import { attempt } from "../result";
import { errMessage } from "../util";
import {
  type CartographerClient,
  type ParsedFileOutput,
  spawnCartographer,
} from "./client";
import { type SyncMode, syncIndex } from "./sync";

type SyncResult = { readonly ok: true } | { readonly ok: false; error: string };

type CartographerDeps = {
  readonly spawnCartographer: (
    binary: string,
    projectPath: string,
  ) => Promise<CartographerClient>;
  readonly syncIndex: (
    projectPath: string,
    parsed: readonly ParsedFileOutput[],
    mode: SyncMode,
  ) => Promise<SyncResult>;
};

type ProjectDeps = CartographerDeps & {
  readonly listFiles: (projectPath: string, log: Logger) => Promise<string[]>;
};

const SPAWN_FAILED = "cartographer spawn failed";

/**
 * Every file a full reindex covers, relative to `projectPath`. Resolves
 * empty (and logs why) when git cannot list them.
 */
export const listGitFiles = async (projectPath: string, log: Logger) => {
  // `--cached --others --exclude-standard` covers tracked files AND
  // untracked-but-not-gitignored ones — a full reindex must catch
  // newly-added files that haven't been committed yet.
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: projectPath, stdout: "pipe", stderr: "pipe" },
  );
  const [readErr, text] = await attempt(() => new Response(proc.stdout).text());
  const exitCode = await proc.exited;
  if (readErr || exitCode !== 0) {
    log.warn("git ls-files failed", {
      projectPath,
      exitCode,
      error: readErr?.message,
    });
    return [];
  }
  return text.split("\n").filter((f) => f.length > 0);
};

const defaultProjectDeps: ProjectDeps = {
  listFiles: listGitFiles,
  spawnCartographer: (binary, projectPath) =>
    spawnCartographer(binary, projectPath),
  syncIndex,
};

/** A syncIndex that never rejects: a throw is logged and reported as !ok. */
const writeIndex = async (
  deps: CartographerDeps,
  log: Logger,
  projectPath: string,
  parsed: readonly ParsedFileOutput[],
  mode: SyncMode,
) => {
  const [err, result] = await attempt(() =>
    deps.syncIndex(projectPath, parsed, mode),
  );
  if (err) {
    log.error("syncIndex threw", { projectPath, mode, error: err.message });
    return false;
  }
  if (!result.ok) {
    log.error("syncIndex returned !ok", {
      projectPath,
      mode,
      error: result.error,
    });
  }
  return result.ok;
};

export const reindexProject = async (
  input: {
    readonly projectPath: string;
    readonly cartographerBinary: string | undefined;
    readonly log: Logger;
  },
  deps: ProjectDeps = defaultProjectDeps,
) => {
  const { projectPath, cartographerBinary, log } = input;
  if (!cartographerBinary) return { status: "unconfigured" } as const;

  const files = await deps.listFiles(projectPath, log);
  if (files.length === 0) {
    log.warn("no git-tracked files found — skipping full reindex", {
      projectPath,
    });
    return { status: "no-files" } as const;
  }

  log.info("starting full project reindex", {
    projectPath,
    fileCount: files.length,
  });

  const [spawnErr, client] = await attempt(() =>
    deps.spawnCartographer(cartographerBinary, projectPath),
  );
  if (spawnErr) {
    log.error(SPAWN_FAILED, { projectPath, error: spawnErr.message });
    return { status: "spawn-failed", error: spawnErr.message } as const;
  }

  const parsed: ParsedFileOutput[] = [];
  let parseFailures = 0;
  for (const file of files) {
    // Listed paths are project-root-relative — the canonical form the
    // cart index stores — and cartographer resolves them against its cwd.
    const [err, result] = await attempt(() =>
      client.parseFile(projectPath, file),
    );
    if (err) {
      parseFailures++;
      continue;
    }
    if (result) parsed.push(result);
  }
  client.kill();

  if (parsed.length === 0) {
    log.warn("no files parsed successfully", {
      projectPath,
      attempted: files.length,
      parseFailures,
    });
    return {
      status: "nothing-parsed",
      attempted: files.length,
      parseFailures,
    } as const;
  }

  const syncOk = await writeIndex(deps, log, projectPath, parsed, "replace");
  return {
    status: "synced",
    attempted: files.length,
    parsed: parsed.length,
    parseFailures,
    syncOk,
  } as const;
};

export const reindexFile = async (
  input: {
    readonly projectPath: string;
    /** Passed to cartographer as given — callers relativise first. */
    readonly filePath: string;
    readonly cartographerBinary: string | undefined;
    readonly log: Logger;
  },
  deps: CartographerDeps = defaultProjectDeps,
) => {
  const { projectPath, filePath, cartographerBinary, log } = input;
  if (!cartographerBinary) return { status: "unconfigured" } as const;

  const [spawnErr, client] = await attempt(() =>
    deps.spawnCartographer(cartographerBinary, projectPath),
  );
  if (spawnErr) {
    log.error(SPAWN_FAILED, { projectPath, filePath, error: spawnErr.message });
    return { status: "spawn-failed", error: spawnErr.message } as const;
  }

  const [parseErr, parsed] = await attempt(() =>
    client.parseFile(projectPath, filePath),
  );
  client.kill();
  if (parseErr || !parsed) {
    log.error("parseFile failed", {
      filePath,
      error: parseErr ? errMessage(parseErr) : "parseFile resolved nothing",
    });
    return { status: "parse-failed" } as const;
  }

  const syncOk = await writeIndex(deps, log, projectPath, [parsed], "upsert");
  return { status: "synced", syncOk } as const;
};
