/**
 * Server-side project resolution for queries.
 *
 * Given any project identifier (ULID, git remote, filesystem path),
 * resolves it to the canonical project ID used as the key in cart_file,
 * cart_import, and memory rows. Git remote is tried before filesystem
 * path — it's machine-agnostic and stable across environments.
 *
 * When no identifier is provided, auto-detects from cart_file (existing
 * MCP tool behavior: single project → use it, multiple → error listing).
 */

import { RecordId } from "surrealdb";
import { getDb, queryFirst } from "../db/surreal";
import { log } from "../util/logger";
import { attempt } from "../util/result";

export type ResolutionResult = {
  project: string;
  error: string | null;
};

/** Strip the "project:" table prefix from a SurrealDB RecordId. */
const idString = (id: string | RecordId) => {
  if (id instanceof RecordId) return String(id.id);
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
};

/**
 * Resolve a project identifier to the canonical ID for DB queries.
 *
 * Resolution order (first match wins):
 *   1. Project record by ID (direct lookup)
 *   2. Git remote (machine-agnostic, stable across environments)
 *   3. Filesystem path (machine-specific fallback)
 *   4. Raw input as-is (legacy data back-compat)
 *
 * When input is omitted, auto-detects from cart_file.
 */
export async function resolveProjectForQuery(input?: string) {
  if (!input) return autoDetect();

  // 1. Try as project record ID — SELECT FROM a RecordId returns the row
  //    if it exists, empty array if not. No error for missing records.
  const [idErr, byId] = await attempt(() =>
    queryFirst<{ id: string | RecordId }>(`SELECT id FROM $id`, {
      id: new RecordId("project", input),
    }),
  );
  if (!idErr && byId) {
    return { project: idString(byId.id), error: null };
  }

  // 2. Try as git remote — stable, globally unique, machine-independent.
  const [remoteErr, byRemote] = await attempt(() =>
    queryFirst<{ id: string | RecordId }>(
      `SELECT id FROM project WHERE git_remote = $input LIMIT 1`,
      { input },
    ),
  );
  if (!remoteErr && byRemote) {
    return { project: idString(byRemote.id), error: null };
  }

  // 3. Try as filesystem path — machine-specific but works for local-only
  //    projects that haven't been pushed to a remote yet.
  const [pathErr, byPath] = await attempt(() =>
    queryFirst<{ id: string | RecordId }>(
      `SELECT id FROM project WHERE local_path = $input LIMIT 1`,
      { input },
    ),
  );
  if (!pathErr && byPath) {
    return { project: idString(byPath.id), error: null };
  }

  // 4. No match — return input as-is for legacy back-compat. Pre-UUID
  //    data was keyed by filesystem path; those rows still need to match.
  log.debug(
    { input },
    "project identifier not found in project table, using raw value",
  );
  return { project: input, error: null };
}

/**
 * Auto-detect the project from cart_file when no identifier is provided.
 * Single project → use it. Multiple → error with listing.
 */
async function autoDetect() {
  const db = await getDb();
  const [result] = await db.query<[Array<{ project: string; count: number }>]>(
    `SELECT project, count() AS count FROM cart_file GROUP BY project`,
  );

  const projects = result ?? [];

  if (projects.length === 0) {
    return {
      project: "",
      error:
        "No projects indexed. Cartographer auto-indexes when launched from Zed.",
    };
  }

  if (projects.length === 1) {
    return { project: projects[0]?.project ?? "", error: null };
  }

  const list = projects
    .map((p) => `  - ${p.project} (${p.count} files)`)
    .join("\n");
  return { project: "", error: `Multiple projects. Specify one:\n${list}` };
}
