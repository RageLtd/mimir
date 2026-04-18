/**
 * Git remote detection for project identity.
 *
 * Shells out to `git config --get remote.origin.url` inside the project
 * root. When the directory isn't a repo or has no `origin` remote, returns
 * null — the caller falls back to using the local path as the identifier.
 *
 * Remotes are normalised before return: trailing `.git`, trailing slashes,
 * and enclosing whitespace are stripped so the same repo accessed via SSH
 * (`git@github.com:org/repo.git`) or HTTPS (`https://github.com/org/repo`)
 * resolves to the same canonical string after a downstream normaliser
 * rewrites the scheme. For now we only trim — the canonical form upgrade
 * is a separate concern once we know how often HTTPS/SSH both exist.
 */

import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "project-git");

const runGitOrigin = async (projectPath: string) => {
  const proc = Bun.spawn(["git", "config", "--get", "remote.origin.url"], {
    cwd: projectPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const trimmed = stdout.trim().replace(/\.git$/, "").replace(/\/$/, "");
  return trimmed || null;
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
    logger.debug(
      "git remote detection failed at %s: %s",
      projectPath,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });
