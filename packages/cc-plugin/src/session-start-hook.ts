/**
 * `mimir-cc session-start` — run by the hooks module off the session's
 * first prompt, with its `session_id` and `cwd` and no `source`.
 *
 * The hook itself does one thing: on `startup` or `resume` — a payload
 * without `source` counts as a startup — it spawns a detached worker and
 * returns, so the developer's first prompt is never behind it. `/clear`
 * and `/compact` don't represent a new working period and spawn nothing.
 *
 * The worker does the real session-start work, in order:
 *   1. Silent key reconcile (MIM-87) then blind org sync (MIM-88): fulfil
 *      pending wraps, pull/push org memories — no embedder spawn, never
 *      mints secrets. Bounded, because the worker process exits when the
 *      reindex is done and a hung request would otherwise keep it alive.
 *   2. Idle-journal prune: every session journal not written for
 *      SESSION_JOURNAL_MAX_IDLE_DAYS is dropped (session-journal.ts), and
 *      the payload files no run read are swept (hook-payload.ts).
 *   3. Full project re-index of the brain's cartographer view: every
 *      git-tracked file parsed via the cartographer binary and written with
 *      `mode: "replace"`, so anything deleted or moved since the last
 *      session drops out. The reindex-hook (Edit/Write/MultiEdit) uses
 *      `mode: "upsert"` thereafter.
 *
 * Sync and re-index used to be awaited in the hook, bounded at 15 s — which held the
 * first prompt for ~7 s on a cold start. The hooks module now starts this
 * only after the first prompt's retrieve, so the first turn always sees the
 * replica and index as the last session left them; pulled rows and the
 * fresh index are there from a later turn.
 */

import { spawn } from "node:child_process";
import { reconcileFromSharedConfig } from "@mimir/plugin-core/keys/cli";
import { resolveProjectRoot } from "@mimir/plugin-core/project";
import { activeProjectId } from "@mimir/plugin-core/project/active";
import { attempt } from "@mimir/plugin-core/result";
import { reconcileAndSync as bootSync } from "@mimir/plugin-core/sync/boot";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { readConfig } from "./config";
import { readPayload, sweepPayloads } from "./hook-payload";
import { createLogger } from "./logger";
import { pruneIdleJournals } from "./session-journal";

const log = createLogger("session-start-hook");

export type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly source?: "startup" | "resume" | "clear" | "compact";
};

const RESCAN_SOURCES = new Set(["startup", "resume"]);
/** Reconcile + sync budget inside the worker; a miss retries next session. */
const BOOT_SYNC_DEADLINE_MS = 60_000;

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
  log.info("spawning session-start worker", {
    sessionId: input.session_id,
    cwd,
    projectRoot,
    source,
  });
  deps.spawnWorker(projectRoot);
  return 0;
};

const reconcileAndSync = () =>
  bootSync(
    { log, deadlineMs: BOOT_SYNC_DEADLINE_MS },
    { reconcile: reconcileFromSharedConfig, sync: syncFromSharedConfig },
  );

const reindex = async (projectPath: string) => {
  const start = Date.now();

  const config = await readConfig();
  if (!config?.cartographerBinary) {
    log.debug("no cartographer configured — skipping full reindex", {
      projectPath,
    });
    return;
  }

  const { reindexProject } = await import(
    "@mimir/plugin-core/cartographer/reindex"
  );
  // Listed paths stay project-root-relative — the form the reindex and
  // file-context hooks query with.
  const outcome = await reindexProject({
    projectPath,
    cartographerBinary: config.cartographerBinary,
    log,
  });
  if (outcome.status !== "synced") return;

  // Deterministic local project identity; no path, remote, or manifest
  // metadata crosses the server boundary.
  const projectId = await activeProjectId(projectPath, {
    config,
    log,
    failure: {
      level: "debug",
      message: "project id unresolved",
      context: { projectPath },
    },
  });

  log.info("session-start reindex complete", {
    projectPath,
    projectId,
    attempted: outcome.attempted,
    parsed: outcome.parsed,
    parseFailures: outcome.parseFailures,
    syncOk: outcome.syncOk,
    elapsed: `${Date.now() - start}ms`,
  });
};

export const runWorker = async (
  projectPath: string,
  deps: {
    readonly reconcileAndSync: () => Promise<Record<string, unknown>>;
    readonly sweepPayloads: (now: number) => ReturnType<typeof sweepPayloads>;
    readonly reindex: (projectPath: string) => Promise<void>;
  } = { reconcileAndSync, sweepPayloads, reindex },
) => {
  const [syncErr, synced] = await attempt(deps.reconcileAndSync);
  if (syncErr) {
    log.warn("boot reconcile failed", { error: syncErr.message });
  } else {
    log.info("org sync", { ...synced });
  }
  pruneIdleJournals();
  const swept = await deps.sweepPayloads(Date.now());
  if (swept.removed > 0 || swept.failures.length > 0)
    log.info("payload sweep", { ...swept });
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
  return runHook(await safeParseHookInput(await readPayload()));
};
