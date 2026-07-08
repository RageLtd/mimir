/**
 * SessionStart hook — full project re-index of the brain's cartographer view.
 *
 * Fires when CC starts or resumes a session. Spawns a detached worker that
 * walks every git-tracked file in the project, parses each via the
 * cartographer binary, and ships the full set to mimir-server with
 * `mode: "replace"` so anything deleted or moved since the last session is
 * dropped from the index. The reindex-hook (Edit/Write/MultiEdit) uses
 * `mode: "upsert"` thereafter, so the full picture stays warm and
 * incremental edits don't evict their neighbours.
 *
 * Only fires on source === "startup" or "resume" — `/clear` and `/compact`
 * don't represent a new working period and shouldn't trigger a re-scan.
 *
 * The hook returns 0 immediately after detaching the worker. CC's startup
 * latency is unaffected; the brain catches up in the background while the
 * developer types their first prompt.
 */

import { spawn } from "node:child_process";
import {
  collectProjectMetadata,
  getOrResolveProjectId,
  patchProjectMetadata,
} from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("session-start-hook");

type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly source?: "startup" | "resume" | "clear" | "compact";
};

const RESCAN_SOURCES = new Set(["startup", "resume"]);

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const safeParseHookInput = async (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  const [err, parsed] = await attempt(async () => JSON.parse(raw) as HookInput);
  return err ? ({} as HookInput) : parsed;
};

const spawnWorker = (projectPath: string) => {
  const child = spawn(
    process.execPath,
    ["session-start", "--worker", projectPath],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
};

const runHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);
  const source = input.source ?? "startup";

  if (!RESCAN_SOURCES.has(source)) {
    log.debug("source does not warrant rescan, skipping", { source });
    return 0;
  }

  const cwd = input.cwd ?? process.cwd();

  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.debug("no cartographer configured — skipping full reindex", {
      cwd,
      source,
    });
    return 0;
  }

  log.info("spawning session-start reindex worker", { cwd, source });
  spawnWorker(cwd);
  return 0;
};

const listGitFiles = async (projectPath: string) => {
  // `--cached --others --exclude-standard` covers tracked files AND
  // untracked-but-not-gitignored files. Plain `git ls-files` would
  // miss anything not yet committed (the whole point of running a
  // full reindex on session start is to catch deletions, additions,
  // and edits since last session — including newly-added files
  // that haven't been committed yet).
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [readErr, text] = await attempt(() => new Response(proc.stdout).text());
  const exitCode = await proc.exited;
  if (readErr || exitCode !== 0) {
    log.warn("git ls-files failed", {
      projectPath,
      exitCode,
      error: readErr?.message,
    });
    return [] as string[];
  }
  return text.split("\n").filter((f) => f.length > 0);
};

const runWorker = async (projectPath: string) => {
  const start = Date.now();

  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.warn("worker started but no cartographer configured", { projectPath });
    return 0;
  }

  const files = await listGitFiles(projectPath);
  if (files.length === 0) {
    log.warn("no git-tracked files found — skipping full reindex", {
      projectPath,
    });
    return 0;
  }

  log.info("starting full project reindex", {
    projectPath,
    fileCount: files.length,
  });

  const { spawnCartographer } = await import(
    "@mimir/plugin-core/cartographer/client"
  );
  const { syncIndex } = await import("@mimir/plugin-core/cartographer/sync");

  const [spawnErr, client] = await attempt(() =>
    spawnCartographer(config.cartographerBinary as string, projectPath),
  );
  if (spawnErr || !client) {
    log.error("cartographer spawn failed", {
      projectPath,
      error: spawnErr?.message,
    });
    return 0;
  }

  const parsed = [];
  let parseFailures = 0;
  for (const file of files) {
    // git ls-files emits paths relative to the project root, which is the
    // canonical form everything downstream now agrees on. Cartographer
    // parses paths relative to its own cwd (= projectPath here), so
    // passing the relative form through is the right call — and the
    // file_path stamped onto the parsed output stays relative, matching
    // what the reindex and file-context hooks query with after Slice 1.
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
    return 0;
  }

  // Project-registry metadata refresh (stays server-side — the registry
  // holds no code content): resolve the UUID, scan manifest files, PATCH
  // the project record. Fire-and-forget; never gates the local sync.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
    config.apiKey,
  ).catch(() => null);
  if (projectId) {
    collectProjectMetadata(projectPath)
      .then((metadata) =>
        patchProjectMetadata(
          config.serverUrl,
          config.apiKey,
          projectId,
          metadata,
        ),
      )
      .catch((err) =>
        log.warn("metadata refresh failed", {
          projectId,
          error: errMessage(err),
        }),
      );
  }

  // Local write (MIM-91): full-scan replace drops deleted/moved files.
  const result = await syncIndex(projectPath, parsed, "replace").catch(
    (err) => {
      log.error("syncIndex threw", { error: errMessage(err) });
      return { ok: false, error: errMessage(err) };
    },
  );

  log.info("session-start reindex complete", {
    projectPath,
    projectId,
    attempted: files.length,
    parsed: parsed.length,
    parseFailures,
    syncOk: result.ok,
    elapsed: `${Date.now() - start}ms`,
  });
  return 0;
};

export const runSessionStartCommand = async (args: readonly string[]) => {
  if (args[0] === "--worker") {
    const projectPath = args[1];
    if (!projectPath) {
      log.error("worker missing project path arg");
      return 1;
    }
    return runWorker(projectPath);
  }
  return runHook();
};
