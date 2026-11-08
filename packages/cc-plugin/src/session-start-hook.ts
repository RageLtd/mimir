/**
 * `mimir-cc session-start` — run by the hooks module on
 * `classic.SessionStart` with its payload.
 *
 * The hook itself does one thing: on `startup` or `resume` it spawns a
 * detached worker and returns, so the developer's first prompt is never
 * behind it. `/clear` and `/compact` don't represent a new working period
 * and spawn nothing.
 *
 * The worker does the real session-start work, in order:
 *   1. Silent key reconcile (MIM-87) then blind org sync (MIM-88): fulfil
 *      pending wraps, pull/push org memories — no embedder spawn, never
 *      mints secrets. Bounded, because the worker process exits when the
 *      reindex is done and a hung request would otherwise keep it alive.
 *   2. Full project re-index of the brain's cartographer view: every
 *      git-tracked file parsed via the cartographer binary and written with
 *      `mode: "replace"`, so anything deleted or moved since the last
 *      session drops out. The reindex-hook (Edit/Write/MultiEdit) uses
 *      `mode: "upsert"` thereafter.
 *
 * Both used to be awaited in the hook, bounded at 15 s — which held the
 * first prompt for ~7 s on a cold start. A first-turn retrieve may now race
 * the sync; pulled rows land a few seconds later and are there for the
 * next turn.
 */

import { spawn } from "node:child_process";
import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import {
  getOrResolveProjectId,
  resolveProjectRoot,
} from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { errMessage } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
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
  // The session cwd follows Bash `cd`; the full-replace index write must
  // land under the same root the file-context and reindex hooks read.
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

const reindex = async (projectPath: string) => {
  const start = Date.now();

  const config = await readConfig();
  if (!config?.cartographerBinary) {
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
    spawnCartographer(config.cartographerBinary as string, projectPath),
  );
  if (spawnErr || !client) {
    log.error("cartographer spawn failed", {
      projectPath,
      error: spawnErr?.message,
    });
    return;
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
  return runHook(await safeParseHookInput(await readStdin()));
};
