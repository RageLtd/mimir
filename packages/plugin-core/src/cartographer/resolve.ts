/**
 * Cartographer binary resolution — shared by every distribution's
 * installer so the code-index legs can't be silently mis-wired.
 *
 * Resolution order:
 *   1. An explicitly requested path (--cartographer) is validated and
 *      FAILS LOUDLY when missing or not executable — a typo'd path used
 *      to install "successfully" and leave the index legs dark forever.
 *   2. No request → look for `cartographer` on $PATH (Bun.which).
 *   3. Not on $PATH → check the standard ~/.local/bin install location.
 *      GUI/editor-launched processes frequently inherit a reduced $PATH.
 *   4. Still absent → prompt the user for a path (interactive TTY only;
 *      non-TTY runs skip the prompt).
 *   5. Blank/absent answer → code indexing disabled, stated explicitly.
 *
 * The prompt, fallback paths, and which lookup are injectable so tests
 * never touch the real $PATH, home directory, or a terminal.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attemptSync } from "../result";

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

/**
 * Default interactive prompt: one line from stdin. Non-TTY contexts
 * (CI, scripted updates) return null immediately — prompting a pipe
 * would hang the install.
 */
const defaultPromptForPath = async () => {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(
    "cartographer not found on $PATH. Path to the cartographer binary " +
      "(blank to disable code indexing): ",
  );
  for await (const line of console) {
    return line.trim().length > 0 ? line.trim() : null;
  }
  return null;
};

export type ResolveCartographerOptions = {
  /** Explicit path from the --cartographer flag or stored config. */
  readonly requested?: string;
  /** Injectable $PATH lookup — defaults to Bun.which. */
  readonly which?: (command: string) => string | null;
  /** Injectable well-known paths — defaults to ~/.local/bin/cartographer. */
  readonly fallbackPaths?: readonly string[];
  /** Injectable interactive fallback — defaults to a TTY-gated prompt. */
  readonly promptForPath?: () => Promise<string | null>;
};

export const resolveCartographerBinary = async (
  opts: ResolveCartographerOptions = {},
) => {
  const which = opts.which ?? ((command: string) => Bun.which(command));
  const fallbackPaths = opts.fallbackPaths ?? [
    join(process.env.HOME ?? homedir(), ".local", "bin", "cartographer"),
  ];
  const promptForPath = opts.promptForPath ?? defaultPromptForPath;

  // 1. Explicit request — the one case that must fail loudly on a bad
  //    path rather than degrade: the user told us where it is.
  if (opts.requested) {
    if (isExecutableFile(opts.requested)) {
      return { ok: true as const, binary: opts.requested };
    }
    return {
      ok: false as const,
      error: `cartographer binary invalid: ${describeInvalid(opts.requested)}`,
    };
  }

  // 2. $PATH auto-detect. A which hit that fails validation (stale
  //    shim, broken symlink) falls through to the prompt instead of
  //    erroring — the user never asserted that path.
  const found = which("cartographer");
  if (found && isExecutableFile(found)) {
    return { ok: true as const, binary: found };
  }

  // 3. Well-known user install locations. GUI/editor processes may not
  //    inherit the shell PATH that contains ~/.local/bin.
  for (const path of fallbackPaths) {
    if (isExecutableFile(path)) {
      return { ok: true as const, binary: path };
    }
  }

  // 4. Interactive fallback.
  const entered = await promptForPath();
  if (entered === null || entered.length === 0) {
    return {
      ok: true as const,
      binary: null,
      reason: "not on $PATH and no path provided — code indexing disabled",
    };
  }
  if (isExecutableFile(entered)) {
    return { ok: true as const, binary: entered };
  }
  // 5. A hand-entered path that doesn't validate is an explicit
  //    assertion again — fail loudly, don't quietly disable.
  return {
    ok: false as const,
    error: `cartographer binary invalid: ${describeInvalid(entered)}`,
  };
};

/** Named alias for consumers — derived from inference, never asserted. */
export type CartographerResolution = Awaited<
  ReturnType<typeof resolveCartographerBinary>
>;
