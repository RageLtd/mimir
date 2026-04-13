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
  readonly indexedAt: string;
  readonly files: readonly {
    readonly path: string;
    readonly language: string;
    readonly imports: readonly string[];
    readonly exports: readonly string[];
    readonly symbols: readonly {
      readonly kind: string;
      readonly name: string;
      readonly line: number;
      readonly column: number;
    }[];
    readonly size: number;
    readonly mtime: string;
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

  try {
    const db = await getDb();

    // Delete existing records for this project (full replace)
    await db.query(`DELETE cart_file WHERE project = $project`, {
      project: payload.rootPath,
    });
    await db.query(`DELETE cart_import WHERE project = $project`, {
      project: payload.rootPath,
    });

    // Insert new file records
    for (const file of payload.files) {
      const searchable = [
        file.path,
        ...file.imports,
        ...file.exports,
        ...file.symbols.map((s: { name: string }) => s.name),
      ].join(" ");

      await db.query(
        `CREATE cart_file CONTENT {
          project: $project,
          file_path: $file_path,
          language: $language,
          symbols: $symbols,
          searchable: $searchable,
          indexed_at: $indexed_at
        }`,
        {
          project: payload.rootPath,
          file_path: file.path,
          language: file.language,
          symbols: JSON.stringify(file.symbols),
          searchable,
          indexed_at: payload.indexedAt,
        },
      );

      // Insert import records
      for (const imp of file.imports) {
        await db.query(
          `CREATE cart_import CONTENT {
            project: $project,
            source_path: $source_path,
            target_path: $target_path,
            symbols: $symbols,
            indexed_at: $indexed_at
          }`,
          {
            project: payload.rootPath,
            source_path: file.path,
            target_path: imp,
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
        project: payload.rootPath,
        files: payload.stats.totalFiles,
        symbols: payload.stats.totalSymbols,
        elapsed: `${elapsed}ms`,
      },
      "cartographer index synced",
    );

    return c.json({
      ok: true,
      project: payload.rootPath,
      files: payload.stats.totalFiles,
      symbols: payload.stats.totalSymbols,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { error: msg, project: payload.rootPath },
      "cartographer sync failed",
    );
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
