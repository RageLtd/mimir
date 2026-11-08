/**
 * Project root resolution.
 *
 * A host's session cwd can drift below the repository root (Claude Code's
 * follows Bash `cd`), and the cart index keys its rows on one stable root
 * path. The git toplevel is that root; outside a repository the input is
 * already the best answer.
 *
 * The root is derived from `--show-cdup` against the caller's own path
 * rather than taken from `--show-toplevel`, which reports the physical
 * path: hosts hand file paths through the same (possibly symlinked) prefix
 * as their cwd, and a physical root would relativise those to `../` paths.
 */

import { resolve } from "node:path";
import { createLoggerFactory } from "../logger";
import { attempt } from "../result";

const log = createLoggerFactory("mimir-plugin").createLogger("project-root");

const gitCdup = async (cwd: string) => {
  const proc = Bun.spawn(["git", "rev-parse", "--show-cdup"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return code === 0 ? stdout.trim() : null;
};

/**
 * Resolve `cwd` to its git repository root in the caller's path form, or
 * return it unchanged when it is not inside a repository. Never throws — a
 * missing git binary or an unreadable directory degrades to the input.
 */
export const resolveProjectRoot = async (cwd: string) => {
  const [err, cdup] = await attempt(() => gitCdup(cwd));
  if (err) {
    log.debug("git root resolution failed", { cwd, error: err.message });
  }
  return cdup === null ? cwd : resolve(cwd, cdup);
};
