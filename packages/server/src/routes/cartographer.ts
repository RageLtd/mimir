/**
 * Cartographer Sync Endpoint
 *
 * POST /v1/cartographer/sync
 *
 * Receives codebase index data from mimir-acp and persists to SurrealDB.
 * This replaces the MCP-based indexing path — mimir-acp now owns local
 * tree-sitter scanning and pushes the index to the server.
 *
 * The index is stored per-project using the existing cart_file and
 * cart_import tables. A sync performs a full replace: delete all existing
 * records for the project, then insert the new ones.
 */

import { Hono } from "hono";
import { requestScope } from "../db/build-scope";
import { closeScope } from "../db/scope";
import { type IdentityEnv, scopeOrgId } from "../middleware/identity";
import { resolveProjectForQuery } from "../projects/resolve-for-query";
import { ensureProjectId } from "../projects/store";
import { log } from "../util/logger";
import { attempt } from "../util/result";
import { fileInfoHandler } from "./cartographer-file-info";

export const cartographer = new Hono<IdentityEnv>();

cartographer.post("/file-info", fileInfoHandler);

/**
 * Index payload from mimir-acp.
 * Matches the CartographerIndex type from mimir-acp.
 */
type IndexPayload = {
  readonly rootPath: string;
  /**
   * Canonical project id from /v1/projects/resolve. Preferred key for
   * cart_file / cart_import rows — stable across machines and path
   * changes. When absent, rootPath is resolved (get-or-create) to a
   * canonical id at this boundary; the raw path never reaches storage.
   */
  readonly projectId?: string;
  /**
   * Sync mode:
   *   "replace" — wipe the project's entire cart_file/cart_import set
   *               and re-insert from this payload. Default for back-compat.
   *               Used by full project scans (e.g. SessionStart reindex).
   *   "upsert"  — for each file in the payload, delete existing rows
   *               keyed by (project, file_path) then insert the new ones,
   *               leaving the rest of the project's index untouched.
   *               Used by single-file reindexes after Edit/Write so the
   *               index isn't wiped on every keystroke.
   */
  readonly mode?: "replace" | "upsert";
  readonly indexedAt: string;
  readonly files: readonly {
    readonly path: string;
    readonly language: string;
    /**
     * Imports as `{target, specifier}` pairs. `target` is the resolved
     * absolute path, `specifier` is the raw string as written in source
     * ("./util", "react", "@scope/pkg"). Both are needed: target drives
     * dependency-graph queries, specifier preserves authored-side
     * identity so refactors and aliased imports can be detected.
     */
    readonly imports: readonly {
      readonly target: string;
      readonly specifier: string;
    }[];
    readonly exports: readonly string[];
    readonly symbols: readonly {
      readonly kind: string;
      readonly name: string;
      readonly line: number;
      readonly column: number;
    }[];
    readonly size: number;
    readonly mtime: string;
    /**
     * SHA-256 hex digest of the file contents at sync time. Computed by
     * the client (mimir-acp, mimir-cc-plugin) — server-side filesystems
     * are typically not co-located with source trees. Empty string when
     * the client couldn't read the file at hash time.
     */
    readonly content_hash: string;
  }[];
  readonly stats: {
    readonly totalFiles: number;
    readonly totalSymbols: number;
    readonly languages: Record<string, number>;
  };
};

/**
 * POST /v1/cartographer/sync
 *
 * Sync index data from mimir-acp.
 * Full replace: deletes existing records for the project, then inserts new ones.
 */
cartographer.post("/sync", async (c) => {
  const start = Date.now();

  const [bodyErr, payload] = await attempt(() => c.req.json<IndexPayload>());
  if (bodyErr) {
    log.error({ error: bodyErr.message }, "invalid cartographer sync payload");
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  if (!payload.rootPath || !Array.isArray(payload.files)) {
    log.error({ payload }, "missing required fields in cartographer sync");
    return c.json({ error: "Missing rootPath or files" }, 400);
  }

  const scope = await requestScope(c.get("identity"), scopeOrgId(c));
  try {
    // Resolve to the canonical project id at the boundary — prefer the
    // client-resolved id, get-or-create from rootPath otherwise.
    const projectId = await ensureProjectId(
      scope,
      payload.projectId ?? payload.rootPath,
    );
    if (!projectId) {
      log.error(
        { rootPath: payload.rootPath, projectId: payload.projectId },
        "cartographer sync: failed to resolve project identifier",
      );
      return c.json({ error: "Failed to resolve project identifier" }, 500);
    }
    const mode = payload.mode ?? "replace";

    const [syncErr] = await attempt(async () => {
      const db = scope.db;

      if (mode === "replace") {
        // Wipe the whole project's index — used for full scans (initial
        // import, periodic re-sync, deletion-aware refresh from SessionStart).
        await db.query(
          `DELETE cart_file WHERE project_id = $project_id AND org_id = $scope_org`,
          { project_id: projectId, scope_org: scope.orgId },
        );
        await db.query(
          `DELETE cart_import WHERE project_id = $project_id AND org_id = $scope_org`,
          { project_id: projectId, scope_org: scope.orgId },
        );
      } else {
        // Upsert mode: delete only the rows for the files in this payload.
        // Leaves every other indexed file in the project intact — this is
        // what single-file Edit/Write reindexes should use, so a per-keystroke
        // reindex doesn't evict the rest of the project.
        const filePaths = payload.files.map((f) => f.path);
        if (filePaths.length > 0) {
          await db.query(
            `DELETE cart_file WHERE project_id = $project_id AND org_id = $scope_org AND file_path IN $paths`,
            { project_id: projectId, paths: filePaths, scope_org: scope.orgId },
          );
          await db.query(
            `DELETE cart_import WHERE project_id = $project_id AND org_id = $scope_org AND source_path IN $paths`,
            { project_id: projectId, paths: filePaths, scope_org: scope.orgId },
          );
        }
      }

      // Insert new file records
      for (const file of payload.files) {
        const searchable = [
          file.path,
          // Imports are now {target, specifier} pairs — flatten both into
          // the search index so a search for "react" or "./util" matches
          // alongside resolved paths.
          ...file.imports.map((imp: { target: string }) => imp.target),
          ...file.imports.map((imp: { specifier: string }) => imp.specifier),
          ...file.exports,
          ...file.symbols.map((s: { name: string }) => s.name),
        ].join(" ");

        await db.query(
          // `indexed_at` is typed `datetime` in the schema — SurrealDB
          // does not auto-coerce ISO strings, so cast explicitly. Clients
          // send ISO 8601 (e.g. "2026-05-18T03:52:20.164Z") and the
          // <datetime> prefix turns that into a real datetime value.
          `CREATE cart_file CONTENT {
          project_id: $project_id,
          org_id: $scope_org,
          file_path: $file_path,
          language: $language,
          symbols: $symbols,
          searchable: $searchable,
          content_hash: $content_hash,
          indexed_at: <datetime>$indexed_at
        }`,
          {
            project_id: projectId,
            scope_org: scope.orgId,
            file_path: file.path,
            language: file.language,
            symbols: JSON.stringify(file.symbols),
            searchable,
            // Defensive: clients that haven't been updated to compute the
            // hash will be missing this field — accept it as empty string
            // so the SCHEMAFULL constraint is met without rejecting the sync.
            content_hash: file.content_hash ?? "",
            indexed_at: payload.indexedAt,
          },
        );

        // Insert import records — deduplicate by (target, specifier) within
        // a single file. Multiple import statements pulling different names
        // from the same module (e.g. `import { a } from "./x"` and
        // `import { b } from "./x"`) produce duplicate edges that would
        // violate the cart_import_edge UNIQUE index.
        const seenEdges = new Set<string>();
        for (const imp of file.imports) {
          const edgeKey = `${imp.target}\0${imp.specifier}`;
          if (seenEdges.has(edgeKey)) continue;
          seenEdges.add(edgeKey);

          await db.query(
            // Same datetime cast as cart_file — schema enforces datetime,
            // clients send ISO 8601 strings.
            `CREATE cart_import CONTENT {
            project_id: $project_id,
            org_id: $scope_org,
            source_path: $source_path,
            target_path: $target_path,
            specifier: $specifier,
            symbols: $symbols,
            indexed_at: <datetime>$indexed_at
          }`,
            {
              project_id: projectId,
              scope_org: scope.orgId,
              source_path: file.path,
              target_path: imp.target,
              specifier: imp.specifier,
              symbols: JSON.stringify(
                file.symbols
                  .filter(
                    (s: { kind: string; name: string }) => s.kind === "export",
                  )
                  .map((s: { kind: string; name: string }) => s.name),
              ),
              indexed_at: payload.indexedAt,
            },
          );
        }
      }
    });

    if (syncErr) {
      log.error(
        { error: syncErr.message, projectId },
        "cartographer sync failed",
      );
      return c.json({ error: syncErr.message }, 500);
    }

    const elapsed = Date.now() - start;
    log.info(
      {
        projectId,
        rootPath: payload.rootPath,
        mode,
        files: payload.stats.totalFiles,
        symbols: payload.stats.totalSymbols,
        elapsed: `${elapsed}ms`,
      },
      "cartographer index synced",
    );

    return c.json({
      ok: true,
      project: projectId,
      mode,
      files: payload.stats.totalFiles,
      symbols: payload.stats.totalSymbols,
    });
  } finally {
    await closeScope(scope);
  }
});

/**
 * GET /v1/cartographer/:project
 *
 * Retrieve file list for a specific project.
 * Returns file paths and metadata, not the full index.
 */
cartographer.get("/:project", async (c) => {
  const scope = await requestScope(c.get("identity"), scopeOrgId(c));
  try {
    const rawProject = decodeURIComponent(c.req.param("project"));
    const resolved = await resolveProjectForQuery(scope, rawProject);
    if (resolved.error) {
      return c.json({ error: resolved.error }, 400);
    }
    const project = resolved.project;

    const [fetchErr, files] = await attempt(async () => {
      const [rows] = await scope.db.query<
        [Array<{ file_path: string; language: string; indexed_at: string }>]
      >(
        `SELECT file_path, language, indexed_at FROM cart_file WHERE project_id = $project_id AND org_id = $scope_org ORDER BY file_path`,
        { project_id: project, scope_org: scope.orgId },
      );
      return rows ?? [];
    });

    if (fetchErr) {
      log.error(
        { error: fetchErr.message, project },
        "cartographer fetch failed",
      );
      return c.json({ error: fetchErr.message }, 500);
    }

    if (files.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json({
      project,
      files: files.map((f) => ({
        path: f.file_path,
        language: f.language,
        indexedAt: f.indexed_at,
      })),
    });
  } finally {
    await closeScope(scope);
  }
});

/**
 * GET /v1/cartographer
 *
 * List all indexed projects with file counts.
 */
cartographer.get("/", async (c) => {
  const scope = await requestScope(c.get("identity"), scopeOrgId(c));
  try {
    const [projects = []] = await scope.db.query<
      [Array<{ project_id: string; count: number; indexed_at: string }>]
    >(
      `SELECT project_id, count() AS count, math::max(indexed_at) AS indexed_at FROM cart_file WHERE org_id = $scope_org GROUP BY project_id`,
      { scope_org: scope.orgId },
    );

    return c.json({
      projects: projects.map((p) => ({
        projectId: p.project_id,
        files: p.count,
        indexedAt: p.indexed_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "cartographer list failed");
    return c.json({ error: msg }, 500);
  } finally {
    await closeScope(scope);
  }
});
