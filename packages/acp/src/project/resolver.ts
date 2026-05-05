/**
 * Project resolver — maps a local project path to a canonical server-side
 * project UUID at session start.
 *
 * Flow:
 *   1. Detect `origin` git remote via `git config` (null if not a repo).
 *   2. POST {gitRemote?, localPath} to /v1/projects/resolve on mimir-server.
 *   3. Return the resolved record.
 *
 * On network failure the resolver returns null — the caller falls back to
 * using the raw filesystem path as the identifier for this session's server
 * calls. That preserves the pre-resolver behaviour as a last-resort path.
 *
 * No local cache: with the resolve endpoint edge-deployed the per-session
 * latency is negligible, and a cache adds a second source of truth that can
 * drift. The resolved record is held in `SessionState.projectId` for the
 * lifetime of the session.
 */

import { errMessage } from "../util";
import { createChildLogger, log } from "../utils/log";
import { detectGitRemote } from "./git";
import type { ProjectMetadata } from "./metadata";

const logger = createChildLogger(log, "project-resolver");

export interface ResolvedProject {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly git_remote: string | null;
  readonly local_path: string | null;
  readonly technologies: readonly string[];
  readonly purpose: string | null;
}

export interface ResolverConfig {
  readonly serverUrl: string;
  readonly apiKey: string;
}

const buildHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
});

/**
 * Resolve a project by shelling out to git, then hitting the server's
 * get-or-create endpoint. Returns null on any failure so the caller can
 * fall back to path-based identification without blocking session start.
 */
export const resolveProjectForPath = async (
  cfg: ResolverConfig,
  projectPath: string,
) => {
  const gitRemote = await detectGitRemote(projectPath);
  const body = JSON.stringify({
    gitRemote: gitRemote ?? undefined,
    localPath: projectPath,
  });

  const url = `${cfg.serverUrl}/v1/projects/resolve`;
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(cfg.apiKey),
    body,
  }).catch((err) => {
    logger.warn(
      "project resolve request failed: %s (path=%s)",
      errMessage(err),
      projectPath,
    );
    return null;
  });
  if (!response) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.warn(
      "project resolve returned %d: %s (path=%s)",
      response.status,
      text,
      projectPath,
    );
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    project?: ResolvedProject;
  } | null;
  const project = payload?.project ?? null;
  if (!project || typeof project.id !== "string") {
    logger.warn(
      "project resolve returned invalid payload (path=%s)",
      projectPath,
    );
    return null;
  }
  logger.info(
    "resolved project %s (remote=%s, path=%s)",
    project.id,
    project.git_remote ?? "none",
    projectPath,
  );
  return project;
};

/**
 * PATCH collected metadata to an existing project record. Fire-and-forget
 * safe — returns null on any failure so the caller doesn't need to handle
 * errors beyond logging (which happens here).
 */
export const patchProjectMetadata = async (
  cfg: ResolverConfig,
  projectId: string,
  metadata: ProjectMetadata,
) => {
  const url = `${cfg.serverUrl}/v1/projects/${projectId}`;
  const body = JSON.stringify({
    technologies: metadata.technologies,
    ...(metadata.description ? { description: metadata.description } : {}),
  });

  const response = await fetch(url, {
    method: "PATCH",
    headers: buildHeaders(cfg.apiKey),
    body,
  }).catch((err) => {
    logger.warn(
      "project metadata patch failed: %s (id=%s)",
      errMessage(err),
      projectId,
    );
    return null;
  });
  if (!response) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.warn(
      "project metadata patch returned %d: %s (id=%s)",
      response.status,
      text,
      projectId,
    );
    return null;
  }

  logger.info("patched project metadata for %s", projectId);
  return true;
};
