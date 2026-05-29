/**
 * Git remote detection for project identity.
 *
 * Shells out to `git config --get remote.origin.url` inside the project
 * root. When the directory isn't a repo or has no `origin` remote, returns
 * null — the caller falls back to using the local path as the identifier.
 *
 * Remotes are normalised before return: trailing `.git`, trailing slashes,
 * and enclosing whitespace are stripped so the same repo accessed via SSH
 * or HTTPS produces the same string after a downstream canonical
 * normaliser rewrites the scheme. We only trim here — full
 * canonicalisation is a server-side concern (Slice 1 risk note).
 *
 * Ported from packages/acp/src/project/git.ts. Differences vs the ACP
 * version: uses the plugin's file-based createLogger instead of pino,
 * and inlines the catch into a promise chain so the public API stays
 * `Promise<string | null>` without throwing.
 */

import { createLogger } from "../logger";

const log = createLogger("project-git");

const runGitOrigin = async (projectPath: string) => {
  const proc = Bun.spawn(["git", "config", "--get", "remote.origin.url"], {
    cwd: projectPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const trimmed = stdout
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Detect the `origin` remote URL for a git repo at `projectPath`.
 *
 * Returns the trimmed remote URL when one exists, null when the directory
 * isn't a repo or has no `origin` configured. Never throws — all failures
 * are logged at debug level and reported as null.
 */
export const detectGitRemote = (projectPath: string) =>
  runGitOrigin(projectPath).catch((err) => {
    log.debug("git remote detection failed", {
      projectPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
