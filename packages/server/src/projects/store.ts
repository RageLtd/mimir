/**
 * Project entity store — SQLite edition (MIM-88; Surreal exits).
 *
 * A project is the canonical unit of code the agent works on. Identity is
 * anchored to the git remote when one exists (stable, globally unique,
 * machine-independent). When no remote is available, identity falls back to
 * the local filesystem path — brittle but useful for greenfield directories
 * that haven't been pushed yet.
 *
 * Callers resolve by posting `{ gitRemote?, localPath?, title? }`; the store
 * returns an existing record or creates one. Ids stay the bare 20-char
 * alphanumeric form clients already hold (Surreal-era ids are preserved by
 * scripts/export-projects.ts, new ones are minted locally).
 *
 * Scope is a plain `{ orgId }` — the WHERE clause is the tenant boundary
 * (the identity gate resolved the org; the DB connection is shared).
 */

import { getTenantDb } from "../db/tenant";
import { log } from "../util/logger";

export type ProjectScope = { readonly orgId: string };

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly git_remote: string | null;
  readonly local_path: string | null;
  readonly technologies: readonly string[];
  readonly purpose: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ResolveInput {
  readonly gitRemote?: string;
  readonly localPath?: string;
  readonly title?: string;
  readonly description?: string;
  readonly technologies?: readonly string[];
  readonly purpose?: string;
}

interface ProjectRow {
  id: string;
  title: string | null;
  description: string | null;
  git_remote: string | null;
  local_path: string | null;
  technologies: string | null;
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

const ID_LENGTH = 20;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const generateProjectId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
};

const parseTechnologies = (raw: string | null) => {
  if (!raw) return [] as string[];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.every((t) => typeof t === "string")
    ? parsed
    : [];
};

const rowToProject = (row: ProjectRow) => ({
  id: row.id,
  title: row.title ?? "untitled project",
  description: row.description,
  git_remote: row.git_remote,
  local_path: row.local_path,
  technologies: parseTechnologies(row.technologies),
  purpose: row.purpose,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const deriveTitle = (input: ResolveInput) => {
  if (input.title?.trim()) return input.title.trim();
  if (input.gitRemote) {
    // Extract "owner/repo" or "repo" from common remote URL shapes.
    const match = input.gitRemote.match(/([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  if (input.localPath) {
    const parts = input.localPath.split("/").filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "untitled project";
};

const selectBy = (
  scope: ProjectScope,
  column: "git_remote" | "local_path",
  value: string,
) =>
  getTenantDb()
    .query<ProjectRow, [string, string]>(
      `SELECT * FROM project WHERE ${column} = ? AND org_id = ? LIMIT 1`,
    )
    .get(value, scope.orgId);

const touchColumn = (
  scope: ProjectScope,
  id: string,
  column: "git_remote" | "local_path",
  value: string,
) => {
  getTenantDb()
    .query(
      `UPDATE project SET ${column} = ?, updated_at = datetime('now')
       WHERE id = ? AND org_id = ?`,
    )
    .run(value, id, scope.orgId);
};

/**
 * Get-or-create a project by git remote (primary) or local path (fallback).
 *
 * Lookup order:
 *   1. git_remote exact match (if provided)
 *   2. local_path exact match (if provided)
 *   3. create new with derived title
 *
 * A local_path match that arrives with a git remote upgrades the record's
 * identity (remote recorded); a git_remote match with a new path refreshes
 * the recorded path. Returns null when neither identifier is provided —
 * the route layer validates, this function trusts its inputs.
 */
export async function resolveProject(scope: ProjectScope, input: ResolveInput) {
  if (!input.gitRemote && !input.localPath) return null;

  if (input.gitRemote) {
    const existing = selectBy(scope, "git_remote", input.gitRemote);
    if (existing) {
      if (input.localPath && existing.local_path !== input.localPath) {
        touchColumn(scope, existing.id, "local_path", input.localPath);
        const refreshed = selectBy(scope, "git_remote", input.gitRemote);
        if (refreshed) return rowToProject(refreshed);
      }
      return rowToProject(existing);
    }
  }

  if (input.localPath) {
    const existing = selectBy(scope, "local_path", input.localPath);
    if (existing) {
      if (input.gitRemote && !existing.git_remote) {
        touchColumn(scope, existing.id, "git_remote", input.gitRemote);
        const refreshed = selectBy(scope, "local_path", input.localPath);
        if (refreshed) return rowToProject(refreshed);
      }
      return rowToProject(existing);
    }
  }

  const id = generateProjectId();
  getTenantDb()
    .query(
      `INSERT INTO project (
        id, org_id, git_remote, local_path, title, description,
        technologies, purpose
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      scope.orgId,
      input.gitRemote ?? null,
      input.localPath ?? null,
      deriveTitle(input) ?? null,
      input.description ?? null,
      JSON.stringify(input.technologies ?? []),
      input.purpose ?? null,
    );
  const created = await getProject(scope, id);
  if (!created) return null;
  log.info(
    {
      id,
      title: created.title,
      gitRemote: created.git_remote,
      localPath: created.local_path,
    },
    "project created",
  );
  return created;
}

/**
 * Resolve any client-sent project identifier to the canonical project id,
 * creating the project record when the identifier is unknown. Identifier
 * forms, in resolution order: a canonical id (no slash, verified), a
 * cwd-style path (get-or-create by local_path), or a bare bucket name
 * ("default") treated as a pseudo-path so it get-or-creates stably.
 */
export async function ensureProjectId(scope: ProjectScope, identifier: string) {
  if (!identifier.includes("/")) {
    const existing = await getProject(scope, identifier);
    if (existing) return existing.id;
  }
  const project = await resolveProject(scope, { localPath: identifier });
  return project?.id ?? null;
}

/** Fetch a project by id. */
export async function getProject(scope: ProjectScope, id: string) {
  const row = getTenantDb()
    .query<ProjectRow, [string, string]>(
      "SELECT * FROM project WHERE id = ? AND org_id = ?",
    )
    .get(id, scope.orgId);
  return row ? rowToProject(row) : null;
}

/** Partial update — null values clear fields that are nullable;
 *  undefined skips the field entirely (preserve current value). */
export interface UpdateInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly technologies?: readonly string[];
  readonly purpose?: string | null;
}

export async function updateProject(
  scope: ProjectScope,
  id: string,
  patch: UpdateInput,
) {
  const setParts: string[] = ["updated_at = datetime('now')"];
  const params: (string | null)[] = [];
  if (patch.title !== undefined) {
    setParts.push("title = ?");
    params.push(patch.title);
  }
  if (patch.description !== undefined) {
    setParts.push("description = ?");
    params.push(patch.description);
  }
  if (patch.technologies !== undefined) {
    setParts.push("technologies = ?");
    params.push(JSON.stringify(patch.technologies));
  }
  if (patch.purpose !== undefined) {
    setParts.push("purpose = ?");
    params.push(patch.purpose);
  }
  getTenantDb()
    .query(
      `UPDATE project SET ${setParts.join(", ")} WHERE id = ? AND org_id = ?`,
    )
    .run(...params, id, scope.orgId);
  return getProject(scope, id);
}
