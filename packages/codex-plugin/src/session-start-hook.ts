/**
 * SessionStart hook (ported from cc-plugin).
 *
 * The hook itself does one thing: on `startup` or `resume` it resolves the
 * repository root and spawns a detached worker for it, then returns, so the
 * developer's first prompt is never behind it. `/clear` and `/compact` don't
 * represent a new working period and spawn nothing.
 *
 * The worker does the real session-start work, in order:
 *   1. Silent key reconcile (MIM-87) then blind org sync (MIM-88): fulfil
 *      pending wraps, pull/push org memories — no embedder spawn, never
 *      mints secrets. Bounded, because the reindex is queued behind it and
 *      a hung sync would otherwise block the reindex indefinitely.
 *   2. Full project re-index of the brain's cartographer view: every
 *      git-tracked file parsed via the cartographer binary and written with
 *      `mode: "replace"`, so anything deleted or moved since the last
 *      session drops out. The reindex-hook (apply_patch) uses
 *      `mode: "upsert"` thereafter.
 *
 * A first-turn retrieve may race the sync; pulled rows land a few seconds
 * later and are there for the next turn. The reindex waits behind reconcile
 * + sync (up to the deadline), so on a slow or unreachable server the cart
 * index can be stale for the first turns — the same trade-off the cc-plugin
 * hook accepts.
 */

import { spawn } from "node:child_process";
import type { ParsedFileOutput } from "@mimir/plugin-core/cartographer/client";
import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import {
  getOrResolveProjectId,
  resolveProjectRoot,
} from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { readConfig } from "@mimir/plugin-core/shared-config";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { errMessage } from "@mimir/plugin-core/util";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";

const log = createLogger("session-start-hook");

export type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly source?: "startup" | "resume" | "clear" | "compact";
};

const RESCAN_SOURCES = new Set(["startup", "resume"]);
/** Reconcile + sync budget inside the worker; a miss retries next session. */
const BOOT_SYNC_DEADLINE_MS = 60_000;

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

export const runHook = async (
  input: HookInput,
  deps: { readonly spawnWorker: (projectPath: string) => void } = {
    spawnWorker,
  },
) => {
  const source = input.source ?? "startup";
  if (!RESCAN_SOURCES.has(source)) {
    log.debug("source does not warrant a session-start worker", { source });
    return 0;
  }
  // The session cwd may be a subdirectory; the full-replace index write must
  // land under the same root the reindex and file-context hooks read.
  const cwd = input.cwd ?? process.cwd();
  const projectRoot = await resolveProjectRoot(cwd);
  log.info("spawning session-start worker", { cwd, projectRoot, source });
  deps.spawnWorker(projectRoot);
  return 0;
};

const reconcileAndSync = () =>
  Promise.race([
    (async () => {
      const keys = await reconcileFromSharedConfig();
      log.info("key reconcile", { ...keys });
      return syncFromSharedConfig();
    })(),
    new Promise<{ status: "deadline" }>((resolve) =>
      setTimeout(() => resolve({ status: "deadline" }), BOOT_SYNC_DEADLINE_MS),
    ),
  ]);

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

const reindex = async (projectPath: string) => {
  const start = Date.now();

  const config = await readConfig();
  const cartographerBinary = config?.cartographerBinary;
  if (!config || !cartographerBinary) {
    log.debug("no cartographer configured — skipping full reindex", {
      projectPath,
    });
    return;
  }

  const files = await listGitFiles(projectPath);
  if (files.length === 0) {
    log.warn("no git-tracked files found — skipping full reindex", {
      projectPath,
    });
    return;
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
    spawnCartographer(cartographerBinary, projectPath),
  );
  if (spawnErr || !client) {
    log.error("cartographer spawn failed", {
      projectPath,
      error: spawnErr?.message,
    });
    return;
  }

  const parsed: ParsedFileOutput[] = [];
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
    return;
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
};

export const runWorker = async (
  projectPath: string,
  deps: {
    readonly reconcileAndSync: () => Promise<Record<string, unknown>>;
    readonly reindex: (projectPath: string) => Promise<void>;
  } = { reconcileAndSync, reindex },
) => {
  const [syncErr, synced] = await attempt(deps.reconcileAndSync);
  if (syncErr) {
    log.warn("boot reconcile failed", { error: syncErr.message });
  } else {
    log.info("org sync", { ...synced });
  }
  await deps.reindex(projectPath);
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
  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  return runHook(await readHookInput<HookInput>());
};
