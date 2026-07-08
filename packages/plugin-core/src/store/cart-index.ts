/**
 * Local cartographer index — the code map's store (MIM-91).
 *
 * Local-first replacement for the server's cart_file / cart_import Surreal
 * tables: same record shape and replace/upsert sync semantics, so the
 * reindex workers and file-context hooks port 1:1. Code content is the
 * most sensitive tenant data category and gets the simplest posture in
 * the epic: no sync at all. The index is a derived cache of files already
 * on this disk — rebuild-on-new-machine replaces sync entirely.
 *
 * Keyed by rootPath, not project UUID, deliberately: the index must need
 * zero server round-trips (project resolution is a server registry call).
 * A machine's project is its path; a moved project reindexes on first use.
 *
 * Backed by bun:sqlite like the org replica and user-memory store. FTS5
 * external-content table + trigger trio over `searchable` (path, import
 * targets/specifiers, exports, symbol names) gives BM25 search parity
 * with the server's FULLTEXT index.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createLoggerFactory } from "../logger";
import { attempt } from "../result";
import { mimirHome } from "../util";
import { escapeFtsQuery } from "./org-replica-support";

const log = createLoggerFactory("mimir-plugin").createLogger("cart-index");

export const defaultCartIndexPath = () => join(mimirHome(), "cart-index.db");

// Cap on dependents returned by fileInfo — parity with the server's
// FILE_INFO_DEPENDENT_LIMIT. The model gets a useful "this is a hot
// file" signal even at 20; bigger lists drown the context block.
const FILE_INFO_DEPENDENT_LIMIT = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cart_file (
  root_path    TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  language     TEXT NOT NULL,
  symbols      TEXT NOT NULL,
  searchable   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   TEXT NOT NULL,
  PRIMARY KEY (root_path, file_path)
);

CREATE TABLE IF NOT EXISTS cart_import (
  root_path   TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  specifier   TEXT NOT NULL,
  indexed_at  TEXT NOT NULL,
  PRIMARY KEY (root_path, source_path, target_path, specifier)
);

CREATE INDEX IF NOT EXISTS idx_cart_import_target
  ON cart_import (root_path, target_path);

CREATE VIRTUAL TABLE IF NOT EXISTS cart_file_fts USING fts5(
  searchable,
  content='cart_file',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS cart_file_ai AFTER INSERT ON cart_file BEGIN
  INSERT INTO cart_file_fts(rowid, searchable) VALUES (new.rowid, new.searchable);
END;

CREATE TRIGGER IF NOT EXISTS cart_file_ad AFTER DELETE ON cart_file BEGIN
  INSERT INTO cart_file_fts(cart_file_fts, rowid, searchable)
    VALUES ('delete', old.rowid, old.searchable);
END;

CREATE TRIGGER IF NOT EXISTS cart_file_au AFTER UPDATE OF searchable ON cart_file BEGIN
  INSERT INTO cart_file_fts(cart_file_fts, rowid, searchable)
    VALUES ('delete', old.rowid, old.searchable);
  INSERT INTO cart_file_fts(rowid, searchable) VALUES (new.rowid, new.searchable);
END;
`;

// ── Input/output shapes ──

/** One file from the parse pipeline — the buildIndexPayload file shape. */
export type CartSyncFile = {
  readonly path: string;
  readonly language: string;
  readonly imports: readonly { target: string; specifier: string }[];
  readonly exports: readonly string[];
  readonly symbols: readonly {
    kind: string;
    name: string;
    line: number;
    column: number;
  }[];
  readonly content_hash: string;
};

export type CartSyncMode = "replace" | "upsert";

export type CartSymbol = {
  readonly kind: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
};

export type CartFileInfo = {
  readonly contentHash: string;
  readonly language: string;
  readonly symbols: readonly CartSymbol[];
  readonly imports: readonly { target: string; specifier: string }[];
  readonly dependents: readonly { source: string; specifier: string }[];
};

export const createCartIndex = (dbPath: string) => {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run(SCHEMA);

  /**
   * Write a batch of parsed files, mirroring the server sync semantics:
   *   "replace" — wipe the whole root's index, then insert (full scans).
   *   "upsert"  — delete only rows for the files in this batch, leaving
   *               the rest of the root's index intact (per-file reindex).
   */
  const syncFiles = (
    rootPath: string,
    files: readonly CartSyncFile[],
    mode: CartSyncMode,
  ) => {
    const indexedAt = new Date().toISOString();
    const run = db.transaction(() => {
      if (mode === "replace") {
        db.run("DELETE FROM cart_file WHERE root_path = ?", [rootPath]);
        db.run("DELETE FROM cart_import WHERE root_path = ?", [rootPath]);
      } else {
        const delFile = db.prepare(
          "DELETE FROM cart_file WHERE root_path = ? AND file_path = ?",
        );
        const delImports = db.prepare(
          "DELETE FROM cart_import WHERE root_path = ? AND source_path = ?",
        );
        for (const file of files) {
          delFile.run(rootPath, file.path);
          delImports.run(rootPath, file.path);
        }
      }

      const insFile = db.prepare(
        `INSERT INTO cart_file
           (root_path, file_path, language, symbols, searchable, content_hash, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insImport = db.prepare(
        `INSERT OR IGNORE INTO cart_import
           (root_path, source_path, target_path, specifier, indexed_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const file of files) {
        const searchable = [
          file.path,
          ...file.imports.map((imp) => imp.target),
          ...file.imports.map((imp) => imp.specifier),
          ...file.exports,
          ...file.symbols.map((s) => s.name),
        ].join(" ");

        insFile.run(
          rootPath,
          file.path,
          file.language,
          JSON.stringify(file.symbols),
          searchable,
          file.content_hash ?? "",
          indexedAt,
        );

        for (const imp of file.imports) {
          insImport.run(
            rootPath,
            file.path,
            imp.target,
            imp.specifier,
            indexedAt,
          );
        }
      }
    });
    run();
    return { files: files.length };
  };

  /**
   * Per-file context for the Read hooks — server /file-info parity minus
   * the memories leg (callers fold in replica memories themselves).
   * Returns null when the file isn't indexed; hooks treat that as
   * "skip injection", never as an error.
   */
  const fileInfo = async (rootPath: string, filePath: string) => {
    const row = db
      .prepare<
        { symbols: string; content_hash: string; language: string },
        [string, string]
      >(
        `SELECT symbols, content_hash, language FROM cart_file
          WHERE root_path = ? AND file_path = ?`,
      )
      .get(rootPath, filePath);
    if (!row) return null;

    // JSON.parse is a serialisation boundary — folded to a Result via the
    // house async-arrow idiom. Corrupt symbols JSON degrades LOUDLY to an
    // empty list; the rest of the context block (imports, dependents,
    // hash) still serves rather than failing the whole lookup.
    const [parseErr, parsed] = await attempt(
      async () => JSON.parse(row.symbols) as unknown,
    );
    if (parseErr) {
      log.warn("cart_file.symbols JSON parse failed — using empty list", {
        rootPath,
        filePath,
        error: parseErr.message,
      });
    }
    const symbols: CartSymbol[] =
      !parseErr && Array.isArray(parsed) ? (parsed as CartSymbol[]) : [];

    const imports = db
      .prepare<{ target_path: string; specifier: string }, [string, string]>(
        `SELECT target_path, specifier FROM cart_import
          WHERE root_path = ? AND source_path = ?`,
      )
      .all(rootPath, filePath)
      .map((r) => ({ target: r.target_path, specifier: r.specifier }));

    const dependents = db
      .prepare<
        { source_path: string; specifier: string },
        [string, string, number]
      >(
        `SELECT source_path, specifier FROM cart_import
          WHERE root_path = ? AND target_path = ?
          LIMIT ?`,
      )
      .all(rootPath, filePath, FILE_INFO_DEPENDENT_LIMIT)
      .map((r) => ({ source: r.source_path, specifier: r.specifier }));

    const info: CartFileInfo = {
      contentHash: row.content_hash,
      language: row.language,
      symbols,
      imports,
      dependents,
    };
    return info;
  };

  /** Uncapped forward edges — targets imported by `sourcePath`. */
  const importsOf = (rootPath: string, sourcePath: string) =>
    db
      .prepare<{ target_path: string }, [string, string]>(
        `SELECT DISTINCT target_path FROM cart_import
          WHERE root_path = ? AND source_path = ?`,
      )
      .all(rootPath, sourcePath)
      .map((r) => r.target_path);

  /** Uncapped reverse edges — sources that import `targetPath`. */
  const dependentsOf = (rootPath: string, targetPath: string) =>
    db
      .prepare<{ source_path: string }, [string, string]>(
        `SELECT DISTINCT source_path FROM cart_import
          WHERE root_path = ? AND target_path = ?`,
      )
      .all(rootPath, targetPath)
      .map((r) => r.source_path);

  /**
   * BM25 search over the searchable text (paths, imports, exports, symbol
   * names). OR-joined quoted terms — same lesson as the replica's FTS:
   * natural queries never contain every token.
   */
  const searchFiles = (rootPath: string, query: string, limit = 20) => {
    const escaped = escapeFtsQuery(query);
    if (!escaped) return [];
    return db
      .prepare<
        { file_path: string; language: string; rank: number },
        [string, string, number]
      >(
        `SELECT f.file_path, f.language, fts.rank AS rank
           FROM cart_file_fts fts
           JOIN cart_file f ON f.rowid = fts.rowid
          WHERE cart_file_fts MATCH ? AND f.root_path = ?
          ORDER BY fts.rank
          LIMIT ?`,
      )
      .all(escaped, rootPath, limit)
      .map((r) => ({ path: r.file_path, language: r.language }));
  };

  /**
   * Transitive import walk from an entry file — the graph-query leg.
   * Breadth-first over cart_import edges, depth-capped, cycle-safe.
   */
  const importGraph = (rootPath: string, entryPath: string, maxDepth = 3) => {
    const edges: { source: string; target: string; depth: number }[] = [];
    const visited = new Set<string>([entryPath]);
    let frontier = [entryPath];
    const stmt = db.prepare<{ target_path: string }, [string, string]>(
      `SELECT DISTINCT target_path FROM cart_import
        WHERE root_path = ? AND source_path = ?`,
    );
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const source of frontier) {
        for (const row of stmt.all(rootPath, source)) {
          edges.push({ source, target: row.target_path, depth });
          if (!visited.has(row.target_path)) {
            visited.add(row.target_path);
            next.push(row.target_path);
          }
        }
      }
      frontier = next;
    }
    return edges;
  };

  const listFiles = (rootPath: string) =>
    db
      .prepare<
        { file_path: string; language: string; indexed_at: string },
        [string]
      >(
        `SELECT file_path, language, indexed_at FROM cart_file
          WHERE root_path = ? ORDER BY file_path`,
      )
      .all(rootPath)
      .map((r) => ({
        path: r.file_path,
        language: r.language,
        indexedAt: r.indexed_at,
      }));

  const countFiles = (rootPath: string) => {
    const row = db
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM cart_file WHERE root_path = ?",
      )
      .get(rootPath);
    return row?.n ?? 0;
  };

  const close = () => db.close();

  return {
    syncFiles,
    fileInfo,
    importsOf,
    dependentsOf,
    searchFiles,
    importGraph,
    listFiles,
    countFiles,
    close,
  };
};

export type CartIndex = ReturnType<typeof createCartIndex>;
