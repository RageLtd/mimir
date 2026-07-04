/**
 * Project resolver — maps a local project path to a canonical server-side
 * project UUID at hook-time.
 *
 * Adapted from packages/acp/src/project/resolver.ts. Differences:
 *
 * - **API key via authHeaders (MIM-77).** Attached when configured;
 *   ungated self-hosted servers see no header.
 * - **No SessionState integration.** Caching is the cache module's job.
 * - **Git detection is the caller's responsibility.** The ACP version
 *   shelled out to git inside the resolver. We don't, because doing so
 *   forces tests to mock `./git` via `mock.module()`, which leaks
 *   globally across the bun test run and breaks `git.test.ts`. Splitting
 *   the git step out keeps this module a pure HTTP function — the
 *   `getOrResolveProjectId` helper in `./index.ts` composes the two.
 *
 * Returns the resolved record, or null on any failure (network down,
 * non-2xx, invalid JSON, missing project field). Callers fall back to
 * using the raw filesystem path as the cart_file key. Never throws.
 */

import { authHeaders } from "../config";
import { createLogger } from "../logger";
import { errMessage } from "../util";
import type { ProjectMetadata } from "./metadata";

const log = createLogger("project-resolver");

const RESOLVE_ROUTE = "/v1/projects/resolve";
const PROJECT_ROUTE = "/v1/projects";

export type ResolvedProject = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly git_remote: string | null;
  readonly local_path: string | null;
  readonly technologies: readonly string[];
  readonly purpose: string | null;
};

/**
 * POST to /v1/projects/resolve with the canonical (gitRemote?, localPath)
 * tuple. Returns null on any failure so the caller can fall back to
 * path-based identification without blocking the hook.
 */
export const resolveProjectForPath = async (
  serverUrl: string,
  projectPath: string,
  gitRemote: string | null,
) => {
  const body = JSON.stringify({
    gitRemote: gitRemote ?? undefined,
    localPath: projectPath,
  });

  const url = `${serverUrl}${RESOLVE_ROUTE}`;
  const auth = await authHeaders();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body,
  }).catch((err) => {
    log.warn("project resolve request failed", {
      error: errMessage(err),
      projectPath,
    });
    return null;
  });
  if (!response) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.warn("project resolve returned non-OK", {
      status: response.status,
      body: text,
      projectPath,
    });
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    project?: ResolvedProject;
  } | null;
  const project = payload?.project ?? null;
  if (!project || typeof project.id !== "string") {
    log.warn("project resolve returned invalid payload", { projectPath });
    return null;
  }
  log.info("resolved project", {
    projectId: project.id,
    gitRemote: project.git_remote ?? null,
    projectPath,
  });
  return project;
};

/**
 * PATCH collected manifest metadata onto an existing project record.
 *
 * Fire-and-forget shape — returns null on any failure (network down,
 * non-2xx, etc.) and logs the error. Never throws. The session-start
 * worker calls this after resolve so the project entity always
 * reflects the latest tree state.
 *
 * Skips the request when both fields are empty — no point burning a
 * round-trip to write nothing.
 */
export const patchProjectMetadata = async (
  serverUrl: string,
  projectId: string,
  metadata: ProjectMetadata,
) => {
  if (metadata.technologies.length === 0 && !metadata.description) {
    return null;
  }

  const url = `${serverUrl}${PROJECT_ROUTE}/${projectId}`;
  const body = JSON.stringify({
    technologies: metadata.technologies,
    ...(metadata.description ? { description: metadata.description } : {}),
  });

  const auth = await authHeaders();
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...auth },
    body,
  }).catch((err) => {
    log.warn("project metadata patch failed", {
      error: errMessage(err),
      projectId,
    });
    return null;
  });
  if (!response) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.warn("project metadata patch returned non-OK", {
      status: response.status,
      body: text,
      projectId,
    });
    return null;
  }

  log.info("patched project metadata", {
    projectId,
    technologyCount: metadata.technologies.length,
    hasDescription: metadata.description !== null,
  });
  return true;
};
