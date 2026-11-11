/**
 * Sweeps the file-context hook's per-session state, run when a session
 * ends: a session directory untouched for longer than
 * FILE_CONTEXT_STATE_MAX_AGE_MS goes with everything under it, and the
 * previous layout's flat `<sessionId>.json` files go whatever their age —
 * nothing reads them. Resolves to `{ removed, failures }`; never throws.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { attempt } from "@mimir/plugin-core/result";
import { fileContextStateDir } from "./file-context-hook";

export const FILE_CONTEXT_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const PREVIOUS_LAYOUT_SUFFIX = ".json";

export type FileContextSweepOutcome = {
  readonly removed: number;
  readonly failures: readonly {
    readonly path: string;
    readonly error: string;
  }[];
};

/** True when removed, false when kept; a failure is reported, not thrown. */
const sweepEntry = async (path: string, isDirectory: boolean, now: number) => {
  if (isDirectory) {
    const [statErr, info] = await attempt(() => stat(path));
    if (statErr) return { path, error: statErr.message };
    if (now - info.mtimeMs <= FILE_CONTEXT_STATE_MAX_AGE_MS) return false;
  }
  const [rmErr] = await attempt(() =>
    rm(path, { recursive: true, force: true }),
  );
  return rmErr ? { path, error: rmErr.message } : true;
};

export const sweepFileContextState = async (now: number) => {
  const dir = fileContextStateDir();
  const [listErr, entries] = await attempt(() =>
    readdir(dir, { withFileTypes: true }),
  );
  if (listErr) {
    const absent = "code" in listErr && listErr.code === "ENOENT";
    return {
      removed: 0,
      failures: absent ? [] : [{ path: dir, error: listErr.message }],
    };
  }
  const outcomes = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.isFile() && entry.name.endsWith(PREVIOUS_LAYOUT_SUFFIX)),
      )
      .map((entry) =>
        sweepEntry(join(dir, entry.name), entry.isDirectory(), now),
      ),
  );
  return {
    removed: outcomes.filter((outcome) => outcome === true).length,
    failures: outcomes.flatMap((outcome) =>
      typeof outcome === "object" ? [outcome] : [],
    ),
  };
};
