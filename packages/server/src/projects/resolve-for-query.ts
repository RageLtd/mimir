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
import { type OrgScope, scopedQueryFirst } from "../db/scope";
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
export async function resolveProjectForQuery(scope: OrgScope, input?: string) {
  if (!input) return autoDetect(scope);

  // 1. Try as project record ID — SELECT FROM a RecordId returns the row
  //    if it exists, empty array if not. No error for missing records.
  const [idErr, byId] = await attempt(() =>
    scopedQueryFirst<{ id: string | RecordId }>(
      scope,
      `SELECT id FROM $id WHERE org_id = $scope_org`,
      { id: new RecordId("project", input), scope_org: scope.orgId },
    ),
  );
  if (!idErr && byId) {
    return { project: idString(byId.id), error: null };
  }

  // 2. Try as git remote — stable, globally unique, machine-independent.
  const [remoteErr, byRemote] = await attempt(() =>
    scopedQueryFirst<{ id: string | RecordId }>(
      scope,
      `SELECT id FROM project WHERE git_remote = $input AND org_id = $scope_org LIMIT 1`,
      { input, scope_org: scope.orgId },
    ),
  );
  if (!remoteErr && byRemote) {
    return { project: idString(byRemote.id), error: null };
  }

  // 3. Try as filesystem path — machine-specific but works for local-only
  //    projects that haven't been pushed to a remote yet.
  const [pathErr, byPath] = await attempt(() =>
    scopedQueryFirst<{ id: string | RecordId }>(
      scope,
      `SELECT id FROM project WHERE local_path = $input AND org_id = $scope_org LIMIT 1`,
      { input, scope_org: scope.orgId },
    ),
  );
  if (!pathErr && byPath) {
    return { project: idString(byPath.id), error: null };
  }

  // 4. No match — return input as-is. Post-migration every table keys on
  //    canonical project ids, so a raw passthrough should never match rows;
  //    it fires only for identifiers that simply don't exist. Warn loudly —
  //    a recurring hit here means a client is sending unresolvable ids.
  log.warn(
    { input },
    "project identifier not found in project table — passing through raw (queries will likely match nothing)",
  );
  return { project: input, error: null };
}

/**
 * Auto-detect the project from cart_file when no identifier is provided.
 * Single project → use it. Multiple → error with listing.
 */
async function autoDetect(scope: OrgScope) {
  const [result] = await scope.db.query<
    [Array<{ project_id: string; count: number }>]
  >(
    `SELECT project_id, count() AS count FROM cart_file WHERE org_id = $scope_org GROUP BY project_id`,
    { scope_org: scope.orgId },
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
    return { project: projects[0]?.project_id ?? "", error: null };
  }

  const list = projects
    .map((p) => `  - ${p.project_id} (${p.count} files)`)
    .join("\n");
  return { project: "", error: `Multiple projects. Specify one:\n${list}` };
}
