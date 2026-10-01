/**
 * Cartographer binary resolution — shared by every distribution's
 * installer so the code-index legs can't be silently mis-wired.
 *
 * Two outcomes, nothing in between:
 *   1. An explicitly requested path (--cartographer) is validated and
 *      FAILS LOUDLY when missing or not executable — a typo'd path used
 *      to install "successfully" and leave the index legs dark forever.
 *   2. Otherwise Mimir owns the binary: the latest GitHub release is
 *      downloaded into ~/.mimir/bin (cartographer/install), refreshed on
 *      every install/update when a newer release exists.
 *
 * No $PATH detection, no well-known locations, no reuse of a path an
 * earlier install stored: a binary Mimir didn't fetch is one it can't
 * keep current. Indexing is therefore always on; the only failure modes
 * are an invalid explicit path and an unreachable release with nothing
 * on disk. The downloader is injectable so tests never touch the network.
 */

import { statSync } from "node:fs";
import { attemptSync, type Result } from "../result";

type ProgressLog = (message: string) => void;

/** True when the path names an existing regular file with any execute bit. */
export const isExecutableFile = (path: string) => {
  const [statErr, stats] = attemptSync(() => statSync(path));
  if (statErr) return false;
  return stats.isFile() && (stats.mode & 0o111) !== 0;
};

const describeInvalid = (path: string) => {
  const [statErr, stats] = attemptSync(() => statSync(path));
  if (statErr) return `no file at ${path}`;
  if (!stats.isFile()) return `${path} is not a regular file`;
  return `${path} is not executable`;
};

const defaultDownload = async (log: ProgressLog) => {
  // Lazy: install.ts imports this module for isExecutableFile, and the
  // downloader drags in Bun.$ + the network path an explicit --cartographer
  // run never needs.
  const { installCartographer } = await import("./install");
  return installCartographer(log);
};

export type ResolveCartographerOptions = {
  /** Explicit path from the --cartographer flag — asserted, fails loudly. */
  readonly requested?: string;
  /** Injectable release download — defaults to installCartographer. */
  readonly download?: (log: ProgressLog) => Promise<Result<string>>;
  readonly log?: ProgressLog;
};

export const resolveCartographerBinary = async (
  opts: ResolveCartographerOptions = {},
) => {
  if (opts.requested) {
    if (isExecutableFile(opts.requested)) {
      return { ok: true as const, binary: opts.requested };
    }
    return {
      ok: false as const,
      error: `cartographer binary invalid: ${describeInvalid(opts.requested)}`,
    };
  }

  const [downloadErr, binary] = await (opts.download ?? defaultDownload)(
    opts.log ?? (() => {}),
  );
  if (downloadErr) {
    return { ok: false as const, error: downloadErr.message };
  }
  return { ok: true as const, binary };
};

/** Named alias for consumers — derived from inference, never asserted. */
export type CartographerResolution = Awaited<
  ReturnType<typeof resolveCartographerBinary>
>;
