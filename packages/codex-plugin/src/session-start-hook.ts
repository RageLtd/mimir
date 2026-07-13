/**
 * SessionStart hook — full project re-index of the brain's cartographer
 * view (ported from cc-plugin).
 *
 * Fires when Codex starts or resumes a session. Spawns a detached worker
 * that walks every git-tracked file in the project, parses each via the
 * cartographer binary, and writes the full set to the local cart index
 * with `mode: "replace"` so anything deleted or moved since the last
 * session is dropped. The reindex-hook (apply_patch) uses
 * `mode: "upsert"` thereafter.
 *
 * Only fires on source === "startup" or "resume" — /clear and /compact
 * don't represent a new working period and shouldn't trigger a re-scan.
 *
 * The hook returns 0 immediately after detaching the worker. Codex's
 * startup latency is unaffected; the brain catches up in the background
 * while the developer types their first prompt.
 */

import { spawn } from "node:child_process";
import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { readConfig } from "@mimir/plugin-core/shared-config";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { errMessage } from "@mimir/plugin-core/util";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";

const log = createLogger("session-start-hook");

type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly source?: "startup" | "resume" | "clear" | "compact";
};

const RESCAN_SOURCES = new Set(["startup", "resume"]);

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

  const input = await readHookInput<HookInput>();
  const source = input.source ?? "startup";

  if (!RESCAN_SOURCES.has(source)) {
    log.debug("source does not warrant rescan, skipping", { source });
    return 0;
  }

  const cwd = input.cwd ?? process.cwd();

  // Silent key reconcile (MIM-87) then blind sync (MIM-88): fulfil
  // pending wraps, pull/push org memories (no embedder spawn at boot).
  // Bounded await — the hook process exits after dispatch, so a detached
  // promise would be killed mid-flight; a missed deadline just retries
  // on the next session start. Never mints secrets.
  const RECONCILE_DEADLINE_MS = 15_000;
  const [reconcileErr, reconciled] = await attempt(() =>
    Promise.race([
      (async () => {
        const keys = await reconcileFromSharedConfig();
        log.info("key reconcile", { ...keys });
        return syncFromSharedConfig();
      })(),
      new Promise<{ status: "deadline" }>((resolve) =>
        setTimeout(
          () => resolve({ status: "deadline" }),
          RECONCILE_DEADLINE_MS,
        ),
      ),
    ]),
  );
  if (reconcileErr) {
    log.warn("boot reconcile failed", { error: reconcileErr.message });
  } else {
    log.info("org sync", { ...reconciled });
  }

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
  // untracked-but-not-gitignored files — a full reindex must catch
  // newly-added files that haven't been committed yet.
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
    // git ls-files emits project-root-relative paths — the canonical form
    // the local cart index stores, so lookups from the reindex and
    // file-context hooks match.
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

  // Deterministic local project identity; no path, remote, or manifest
  // metadata crosses the server boundary.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
    config.apiKey,
  ).catch(() => null);
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
