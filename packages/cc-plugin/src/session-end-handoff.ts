/**
 * The session-end hand-off: the file that carries the ending session's
 * whole conversation from the `session-end` runner to its detached worker,
 * and the spawn of that worker.
 *
 * The file lives in `~/.mimir/session-end/`, a directory and a file only
 * this user can read — it is the whole conversation — and the worker
 * removes it once read. A file a dead run left behind is swept by the next
 * write once it is older than HANDOFF_SWEEP_MS.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { attempt } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import { createLogger } from "./logger";

const log = createLogger("session-end-hook");

export const SUBCOMMAND = "session-end";
export const WORKER_FLAG = "--worker";

/** Well past the time a worker takes to read its file after the spawn. */
export const HANDOFF_SWEEP_MS = 10 * 60_000;

/**
 * What the runner hands the worker: the project id and, when the runner
 * marked the summary in flight, the mark's owner token — or, when the
 * runner had no cached project id, the cwd for the worker to resolve.
 */
export type WorkerInput = {
  readonly projectId?: string;
  readonly token?: string;
  readonly cwd?: string;
  readonly window: readonly ModelMessage[];
};

const handOffDir = () => join(mimirHome(), SUBCOMMAND);

/** Remove hand-off files older than the sweep age. */
const sweep = async (dir: string, now: number) => {
  const names = await readdir(dir);
  await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const [statErr, info] = await attempt(() => stat(path));
      // Gone between the listing and the stat: another run swept it.
      if (statErr) return;
      if (now - info.mtimeMs > HANDOFF_SWEEP_MS)
        await rm(path, { force: true });
    }),
  );
};

/** Write the hand-off where only this user can read it; resolves to its path. */
export const writeHandOff = async (input: WorkerInput) => {
  const dir = handOffDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const [sweepErr] = await attempt(() => sweep(dir, Date.now()));
  if (sweepErr) {
    log.warn("session-end: could not sweep old hand-off files", {
      dir,
      error: sweepErr.message,
    });
  }
  const path = join(dir, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(input), { mode: 0o600, flag: "wx" });
  return path;
};

const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/** The parsed file as a WorkerInput, or an error naming what is missing. */
const asWorkerInput = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("window" in value) ||
    !Array.isArray(value.window)
  ) {
    throw new Error("hand-off file carries no window");
  }
  const projectId = "projectId" in value && optionalString(value.projectId);
  const token = "token" in value && optionalString(value.token);
  const cwd = "cwd" in value && optionalString(value.cwd);
  // Serialisation boundary: the runner wrote these messages.
  const window: readonly ModelMessage[] = value.window;
  return {
    ...(projectId ? { projectId } : {}),
    ...(token ? { token } : {}),
    ...(cwd ? { cwd } : {}),
    window,
  } satisfies WorkerInput;
};

/** Read the hand-off for the worker and remove it, read or not. */
export const readHandOff = async (path: string) => {
  const [readErr, raw] = await attempt(() => Bun.file(path).text());
  const [rmErr] = await attempt(() => rm(path, { force: true }));
  if (rmErr) {
    log.warn("session-end: could not remove the hand-off file", {
      path,
      error: rmErr.message,
    });
  }
  if (readErr) throw readErr;
  // Serialisation boundary: JSON the runner wrote.
  const parsed: unknown = JSON.parse(raw);
  return asWorkerInput(parsed);
};

/**
 * Resolves once the child is running, rejects when it could not start.
 * An error the child reports after it started is logged rather than left
 * to go uncaught.
 */
const started = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    let running = false;
    child.once("spawn", () => {
      running = true;
      resolve();
    });
    child.on("error", (err) => {
      if (!running) return reject(err);
      log.warn("session-end: the worker reported an error", {
        pid: child.pid,
        error: err.message,
      });
    });
  });

/**
 * Write the hand-off and let a detached worker go on it. A worker that
 * cannot start takes its hand-off file with it, and the spawn rejects.
 */
export const spawnWorker = async (input: WorkerInput) => {
  const path = await writeHandOff(input);
  const [spawnErr] = await attempt(async () => {
    const child = spawn(process.execPath, [SUBCOMMAND, WORKER_FLAG, path], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    await started(child);
  });
  if (!spawnErr) return;
  const [rmErr] = await attempt(() => rm(path, { force: true }));
  if (rmErr) {
    log.warn("session-end: could not remove an unused hand-off file", {
      path,
      error: rmErr.message,
    });
  }
  throw spawnErr;
};
