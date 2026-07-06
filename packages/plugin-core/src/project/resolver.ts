/**
 * Project resolver — maps a local project path to a canonical server-side
 * project UUID at hook-time.
 *
 * Pure HTTP function: the caller passes the apiKey, the git remote, and
 * the project path. No config reading inside — that would couple this
 * module to a specific filesystem location (e.g. ~/.mimir/config.json)
 * which is per-adapter. Each consumer reads its own config and threads
 * the apiKey in.
 *
 * The companion `getOrResolveProjectId` helper in ./index.ts composes
 * this with `detectGitRemote` and the disk cache, so most call sites
 * don't need to assemble the parts themselves.
 *
 * Returns the resolved record, or null on any failure (network down,
 * non-2xx, invalid JSON, missing project field). Callers fall back to
 * using the raw filesystem path as the cart_file key. Never throws.
 */

import { createLoggerFactory } from "../logger";
import { errMessage } from "../util";
import type { ProjectMetadata } from "./metadata";

const log =
  createLoggerFactory("mimir-plugin").createLogger("project-resolver");

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
 *
 * `apiKey` is the optional bearer token (MIM-77). Pass the value from
 * the consumer's config; absent means the resolver falls back to
 * `MIMIR_API_KEY` env, and absent that, no Authorization header (an
 * ungated self-hosted server). Consumers are responsible for reading
 * their own config — plugin-core never touches the filesystem config.
 */
export const resolveProjectForPath = async (
  serverUrl: string,
  apiKey: string | undefined,
  projectPath: string,
  gitRemote: string | null,
) => {
  const resolvedApiKey = apiKey ?? process.env.MIMIR_API_KEY;
  const body = JSON.stringify({
    gitRemote: gitRemote ?? undefined,
    localPath: projectPath,
  });

  const url = `${serverUrl}${RESOLVE_ROUTE}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (resolvedApiKey) headers.Authorization = `Bearer ${resolvedApiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
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
  apiKey: string | undefined,
  projectId: string,
  metadata: ProjectMetadata,
) => {
  if (metadata.technologies.length === 0 && !metadata.description) {
    return null;
  }

  const resolvedApiKey = apiKey ?? process.env.MIMIR_API_KEY;

  const url = `${serverUrl}${PROJECT_ROUTE}/${projectId}`;
  const body = JSON.stringify({
    technologies: metadata.technologies,
    ...(metadata.description ? { description: metadata.description } : {}),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (resolvedApiKey) headers.Authorization = `Bearer ${resolvedApiKey}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers,
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
