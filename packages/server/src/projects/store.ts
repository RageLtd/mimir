/**
 * Project entity store.
 *
 * A project is the canonical unit of code the agent works on. Identity is
 * anchored to the git remote when one exists (stable, globally unique,
 * machine-independent). When no remote is available, identity falls back to
 * the local filesystem path — brittle but useful for greenfield directories
 * that haven't been pushed yet.
 *
 * Callers resolve by posting `{ gitRemote?, localPath?, title? }`; the store
 * returns an existing record or creates one. Downstream tables (cart_file,
 * message_log, memory) store the project's id portion (after the "project:"
 * prefix) in their `project` field.
 */

import { RecordId } from "surrealdb";
import { queryFirst } from "../db/surreal";
import { log } from "../util/logger";

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
  id: string | RecordId;
  title: string;
  description?: string | null;
  git_remote?: string | null;
  local_path?: string | null;
  technologies?: string[];
  purpose?: string | null;
  created_at: string;
  updated_at: string;
}

/** Strip the "project:" table prefix from a SurrealDB RecordId string. */
const idString = (id: string | RecordId) => {
  if (id instanceof RecordId) return String(id.id);
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
};

const toRid = (row: ProjectRow) =>
  row.id instanceof RecordId
    ? row.id
    : new RecordId("project", idString(row.id));

const rowToProject = (row: ProjectRow) => ({
  id: idString(row.id),
  title: row.title,
  description: row.description ?? null,
  git_remote: row.git_remote ?? null,
  local_path: row.local_path ?? null,
  technologies: row.technologies ?? [],
  purpose: row.purpose ?? null,
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

/**
 * Get-or-create a project by git remote (primary) or local path (fallback).
 *
 * Lookup order:
 *   1. git_remote exact match (if provided)
 *   2. local_path exact match (if provided)
 *   3. create new with derived title
 *
 * When a match is found on local_path but git_remote was provided, the
 * existing record is updated to record the newly-discovered remote — this
 * lets a project that gained a remote after creation upgrade its identity
 * without losing history.
 *
 * Returns null when neither gitRemote nor localPath is provided. Callers
 * should validate at the boundary (route layer) — this function trusts
 * its inputs.
 */
export async function resolveProject(input: ResolveInput) {
  if (!input.gitRemote && !input.localPath) return null;

  if (input.gitRemote) {
    const existing = await queryFirst<ProjectRow>(
      `SELECT * FROM project WHERE git_remote = $remote LIMIT 1`,
      { remote: input.gitRemote },
    );
    if (existing) {
      if (input.localPath && existing.local_path !== input.localPath) {
        const updated = await queryFirst<ProjectRow>(
          `UPDATE $id SET local_path = $path, updated_at = time::now() RETURN AFTER`,
          { id: toRid(existing), path: input.localPath },
        );
        if (updated) return rowToProject(updated);
      }
      return rowToProject(existing);
    }
  }

  if (input.localPath) {
    const existing = await queryFirst<ProjectRow>(
      `SELECT * FROM project WHERE local_path = $path LIMIT 1`,
      { path: input.localPath },
    );
    if (existing) {
      if (input.gitRemote && !existing.git_remote) {
        const updated = await queryFirst<ProjectRow>(
          `UPDATE $id SET git_remote = $remote, updated_at = time::now() RETURN AFTER`,
          { id: toRid(existing), remote: input.gitRemote },
        );
        if (updated) return rowToProject(updated);
      }
      return rowToProject(existing);
    }
  }

  // Optional fields are declared `option<string>` in the schema (see
  // db/surreal.ts:222-226). SurrealDB's `option<T>` accepts T or NONE —
  // literal `null` trips a coercion error ("Expected 'none | string'
  // but found 'NULL'"), so we build the CONTENT payload with absent
  // fields rather than sending null. `technologies` stays in because
  // its schema is `array<string> DEFAULT []` — null would be wrong
  // there too, but `[]` is the right default.
  const fields: Record<string, unknown> = {
    title: deriveTitle(input),
    technologies: input.technologies ?? [],
  };
  if (input.description) fields.description = input.description;
  if (input.gitRemote) fields.git_remote = input.gitRemote;
  if (input.localPath) fields.local_path = input.localPath;
  if (input.purpose) fields.purpose = input.purpose;

  const created = await queryFirst<ProjectRow>(
    `CREATE project CONTENT $fields RETURN AFTER`,
    { fields },
  );
  if (!created) return null;
  log.info(
    {
      id: idString(created.id),
      title: created.title,
      gitRemote: created.git_remote,
      localPath: created.local_path,
    },
    "project created",
  );
  return rowToProject(created);
}

/**
 * Resolve any client-sent project identifier to the canonical project id,
 * creating the project record when the identifier is unknown. This is the
 * API-boundary funnel: downstream tables key exclusively on the id this
 * returns — no path string ever reaches storage.
 *
 * Identifier forms, in resolution order:
 *   1. A canonical id (no slash) — verified against the project table.
 *   2. A cwd-style path — get-or-create by local_path (resolveProject).
 *   3. A bare bucket name like "default" (no slash, no record) — treated
 *      as a pseudo-path so it get-or-creates a stable project record.
 *      A stale id from another machine lands here too: it becomes its
 *      own bucket rather than failing the request.
 */
export async function ensureProjectId(identifier: string) {
  if (!identifier.includes("/")) {
    const existing = await getProject(identifier);
    if (existing) return existing.id;
  }
  const project = await resolveProject({ localPath: identifier });
  return project?.id ?? null;
}

/** Fetch a project by its id portion (no "project:" prefix). */
export async function getProject(id: string) {
  const row = await queryFirst<ProjectRow>(`SELECT * FROM $id`, {
    id: new RecordId("project", id),
  });
  return row ? rowToProject(row) : null;
}

/** Partial update — null values clear fields that are nullable. */
export interface UpdateInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly technologies?: readonly string[];
  readonly purpose?: string | null;
}

export async function updateProject(id: string, patch: UpdateInput) {
  // Build SET clauses dynamically so nullable option<string> fields can be
  // CLEARED via `field = NONE` rather than `field = NULL`. The previous
  // MERGE-with-fields-object approach passed literal `null` through to
  // SurrealDB, which rejects it for `option<string>` schemas with the
  // same coercion error that bit resolveProject's CREATE path:
  //   "Expected `none | string` but found `NULL`"
  //
  // UpdateInput semantics:
  //   undefined → skip the field entirely (preserve current value)
  //   null      → clear (only valid for fields typed `string | null` in
  //               UpdateInput, i.e. description and purpose today)
  //   T         → set to T
  const setParts: string[] = ["updated_at = time::now()"];
  const params: Record<string, unknown> = { id: new RecordId("project", id) };

  if (patch.title !== undefined) {
    setParts.push("title = $title");
    params.title = patch.title;
  }
  if (patch.description !== undefined) {
    if (patch.description === null) {
      setParts.push("description = NONE");
    } else {
      setParts.push("description = $description");
      params.description = patch.description;
    }
  }
  if (patch.technologies !== undefined) {
    setParts.push("technologies = $technologies");
    params.technologies = patch.technologies;
  }
  if (patch.purpose !== undefined) {
    if (patch.purpose === null) {
      setParts.push("purpose = NONE");
    } else {
      setParts.push("purpose = $purpose");
      params.purpose = patch.purpose;
    }
  }

  const row = await queryFirst<ProjectRow>(
    `UPDATE $id SET ${setParts.join(", ")} RETURN AFTER`,
    params,
  );
  return row ? rowToProject(row) : null;
}
