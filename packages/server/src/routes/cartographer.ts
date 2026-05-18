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
import { getDb, queryOne } from "../db/surreal";
import { log } from "../util/logger";

export const cartographer = new Hono();

/**
 * Index payload from mimir-acp.
 * Matches the CartographerIndex type from mimir-acp.
 */
type IndexPayload = {
  readonly rootPath: string;
  /**
   * Canonical project id from /v1/projects/resolve. When present, used as
   * the key in cart_file / cart_import rows — stable across machines and
   * path changes. When absent, we fall back to rootPath for back-compat
   * with older clients.
   */
  readonly projectId?: string;
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

  let payload: IndexPayload;
  try {
    payload = await c.req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "invalid cartographer sync payload");
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  if (!payload.rootPath || !Array.isArray(payload.files)) {
    log.error({ payload }, "missing required fields in cartographer sync");
    return c.json({ error: "Missing rootPath or files" }, 400);
  }

  // Prefer the canonical project id; fall back to rootPath for back-compat.
  const projectKey = payload.projectId ?? payload.rootPath;

  try {
    const db = await getDb();

    // Delete existing records for this project (full replace)
    await db.query(`DELETE cart_file WHERE project = $project`, {
      project: projectKey,
    });
    await db.query(`DELETE cart_import WHERE project = $project`, {
      project: projectKey,
    });

    // Insert new file records
    for (const file of payload.files) {
      const searchable = [
        file.path,
        // Imports are now {target, specifier} pairs — flatten both into
        // the search index so a search for "react" or "./util" matches
        // alongside resolved paths.
        ...file.imports.map((imp) => imp.target),
        ...file.imports.map((imp) => imp.specifier),
        ...file.exports,
        ...file.symbols.map((s: { name: string }) => s.name),
      ].join(" ");

      await db.query(
        // `indexed_at` is typed `datetime` in the schema — SurrealDB
        // does not auto-coerce ISO strings, so cast explicitly. Clients
        // send ISO 8601 (e.g. "2026-05-18T03:52:20.164Z") and the
        // <datetime> prefix turns that into a real datetime value.
        `CREATE cart_file CONTENT {
          project: $project,
          file_path: $file_path,
          language: $language,
          symbols: $symbols,
          searchable: $searchable,
          content_hash: $content_hash,
          indexed_at: <datetime>$indexed_at
        }`,
        {
          project: projectKey,
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

      // Insert import records
      for (const imp of file.imports) {
        await db.query(
          // Same datetime cast as cart_file — schema enforces datetime,
          // clients send ISO 8601 strings.
          `CREATE cart_import CONTENT {
            project: $project,
            source_path: $source_path,
            target_path: $target_path,
            specifier: $specifier,
            symbols: $symbols,
            indexed_at: <datetime>$indexed_at
          }`,
          {
            project: projectKey,
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

    const elapsed = Date.now() - start;
    log.info(
      {
        project: projectKey,
        rootPath: payload.rootPath,
        files: payload.stats.totalFiles,
        symbols: payload.stats.totalSymbols,
        elapsed: `${elapsed}ms`,
      },
      "cartographer index synced",
    );

    return c.json({
      ok: true,
      project: projectKey,
      files: payload.stats.totalFiles,
      symbols: payload.stats.totalSymbols,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg, project: projectKey }, "cartographer sync failed");
    return c.json({ error: msg }, 500);
  }
});

/**
 * GET /v1/cartographer/:project
 *
 * Retrieve file list for a specific project.
 * Returns file paths and metadata, not the full index.
 */
cartographer.get("/:project", async (c) => {
  const project = decodeURIComponent(c.req.param("project"));

  try {
    const files = await queryOne<{
      file_path: string;
      language: string;
      indexed_at: string;
    }>(
      `SELECT file_path, language, indexed_at FROM cart_file WHERE project = $project ORDER BY file_path`,
      { project },
    );

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg, project }, "cartographer fetch failed");
    return c.json({ error: msg }, 500);
  }
});

/**
 * GET /v1/cartographer
 *
 * List all indexed projects with file counts.
 */
cartographer.get("/", async (c) => {
  try {
    const projects = await queryOne<{
      project: string;
      count: number;
      indexed_at: string;
    }>(
      `SELECT project, count() AS count, math::max(indexed_at) AS indexed_at FROM cart_file GROUP BY project`,
    );

    return c.json({
      projects: projects.map((p) => ({
        rootPath: p.project,
        files: p.count,
        indexedAt: p.indexed_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "cartographer list failed");
    return c.json({ error: msg }, 500);
  }
});
