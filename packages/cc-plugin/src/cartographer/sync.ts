/**
 * Cartographer index sync to mimir-server.
 *
 * Forwards the raw JSON output from the cartographer binary's --parse-only
 * mode to mimir-server's sync endpoint. The server persists to SurrealDB
 * so query tools (search, graph walk, file info) on the mimir HTTP MCP
 * see the updated state.
 *
 * Ported from packages/acp/src/cartographer/sync.ts. Logging redirected
 * to stderr; no apiKey handling for the alpha (mimir-server is self-hosted
 * per the user's setup, so unauthenticated HTTP is acceptable).
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { createLogger } from "../logger";
import { errMessage } from "../util";
import type { ParsedFileOutput } from "./client";

const log = createLogger("cartographer-sync");

export type CartographerSyncConfig = {
  readonly serverUrl: string;
  readonly apiKey?: string;
};

type IndexPayload = {
  readonly rootPath: string;
  readonly projectId?: string;
  /**
   * Sync mode (mirrors the server's IndexPayload field):
   *   "replace" — wipe the whole project's index and re-insert. Used for
   *               full project scans (initial load, SessionStart full
   *               re-sync to drop deleted files).
   *   "upsert"  — only touch rows for the files in this payload, leaving
   *               the rest of the project's index intact. Used by the
   *               per-file reindex worker so each Edit doesn't wipe the
   *               other files we've parsed.
   * Default on the server side is "replace" for back-compat.
   */
  readonly mode?: "replace" | "upsert";
  readonly indexedAt: string;
  readonly files: readonly {
    readonly path: string;
    readonly language: string;
    /**
     * Imports as {target, specifier} pairs. target = resolved absolute
     * path, specifier = raw string as written in source. Server keeps
     * both for graph queries and authored-side refactor detection.
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
     * SHA-256 hex of the file contents at sync time. Sent so the server
     * can detect stale-index conditions without filesystem access.
     * Empty string when the file couldn't be read at hash time.
     */
    readonly content_hash: string;
  }[];
  readonly stats: {
    readonly totalFiles: number;
    readonly totalSymbols: number;
    readonly languages: Record<string, number>;
  };
};

const EXPORTED_VISIBILITIES = new Set(["exported", "default_export", "public"]);

/**
 * Compute SHA-256 hex of a file's contents. Returns an empty string when
 * the file isn't readable, when the path is missing from the parser
 * output, or when reading throws — the schema field is required, but
 * none of those conditions should abort the rest of the index sync.
 */
const hashFile = async (rootPath: string, filePath: string | undefined) => {
  if (!filePath || typeof filePath !== "string") return "";
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(rootPath, filePath);
  const buf = await Bun.file(absolute)
    .arrayBuffer()
    .catch(() => null);
  if (!buf) return "";
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
};

export type SyncMode = "replace" | "upsert";

export const buildIndexPayload = async (
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
  projectId?: string | null,
  mode?: SyncMode,
) => {
  const indexedAt = new Date().toISOString();
  const languages: Record<string, number> = {};

  const files = await Promise.all(
    parsedFiles.map(async (file) => {
      languages[file.language] = (languages[file.language] ?? 0) + 1;

      const symbols = file.symbols.map((symbol) => ({
        kind: symbol.kind,
        name: symbol.name,
        line: symbol.line,
        column: 0,
      }));

      const exports = file.symbols
        .filter((symbol) => EXPORTED_VISIBILITIES.has(symbol.visibility))
        .map((symbol) => symbol.name);

      const content_hash = await hashFile(rootPath, file.file_path);

      return {
        path: file.file_path,
        language: file.language,
        imports: file.imports.map((entry) => ({
          target: entry.target,
          specifier: entry.specifier,
        })),
        exports,
        symbols,
        size: 0,
        mtime: indexedAt,
        content_hash,
      };
    }),
  );

  const payload: IndexPayload = {
    rootPath,
    ...(projectId ? { projectId } : {}),
    ...(mode ? { mode } : {}),
    indexedAt,
    files,
    stats: {
      totalFiles: files.length,
      totalSymbols: files.reduce(
        (total, file) => total + file.symbols.length,
        0,
      ),
      languages,
    },
  };

  return payload;
};

/**
 * Per-request file cap. Chosen small enough that even a project full of
 * symbol-heavy files stays well below any reasonable proxy body limit
 * (Caddy / nginx / Cloudflare defaults are usually 1–10MB; 10 files of
 * worst-case symbol data lands well under 1MB).
 *
 * Bulk syncs above the cap are split into chunks here in the client so
 * the plugin works behind whatever proxy the user has — no Caddyfile
 * tweak required.
 */
const SYNC_CHUNK_SIZE = 10;

/**
 * Single-request shipper. Used directly for small syncs and called per
 * chunk by `syncIndex` for large ones.
 */
const shipChunk = async (
  config: CartographerSyncConfig,
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
  projectId: string | null | undefined,
  mode: SyncMode | undefined,
) => {
  const url = `${config.serverUrl}/v1/cartographer/sync`;
  const payload = await buildIndexPayload(
    rootPath,
    parsedFiles,
    projectId,
    mode,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    log.error("sync network error", { error: errMessage(err) });
    return null;
  });
  if (!response) return { ok: false as const, error: "network error" };

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    log.error("sync failed", { status: response.status, body: errText });
    return {
      ok: false as const,
      error: `${response.status}: ${errText}`,
    };
  }

  return { ok: true as const, files: payload.files.length };
};

/**
 * Post parsed cartographer output to the server sync endpoint.
 *
 * When `projectId` is provided, it's injected into the payload so the
 * server keys cart records by the canonical project UUID. Otherwise the
 * server falls back to using `rootPath` (legacy behaviour).
 *
 * `mode` controls server-side behaviour:
 *   "upsert"  — only the files in this payload are replaced (single-file
 *               reindex won't wipe the project).
 *   "replace" — wipe the entire project's index then re-insert (full
 *               re-scans / SessionStart). When omitted the server
 *               defaults to "replace" for back-compat.
 *
 * Bulk syncs (> SYNC_CHUNK_SIZE files) are split client-side into
 * sequential chunks. The FIRST chunk carries the caller's requested
 * `mode` so a `replace` still wipes the project before the new files
 * land; SUBSEQUENT chunks force `upsert` so they don't clobber the
 * first chunk's writes. A mid-stream failure aborts and returns the
 * error — the project's index ends up partial, but the next
 * SessionStart will retry with a fresh `replace` and recover.
 */
export const syncIndex = async (
  config: CartographerSyncConfig,
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
  projectId?: string | null,
  mode?: SyncMode,
) => {
  if (parsedFiles.length <= SYNC_CHUNK_SIZE) {
    const single = await shipChunk(
      config,
      rootPath,
      parsedFiles,
      projectId,
      mode,
    );
    if (!single.ok) return single;
    log.info("sync OK", { rootPath, files: single.files });
    return { ok: true as const };
  }

  const totalChunks = Math.ceil(parsedFiles.length / SYNC_CHUNK_SIZE);
  log.info("chunking large sync", {
    rootPath,
    totalFiles: parsedFiles.length,
    totalChunks,
    chunkSize: SYNC_CHUNK_SIZE,
    requestedMode: mode ?? "replace",
  });

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * SYNC_CHUNK_SIZE;
    const chunk = parsedFiles.slice(offset, offset + SYNC_CHUNK_SIZE);
    // First chunk honours the caller's mode (so a "replace" still wipes
    // the project before any new rows land). Subsequent chunks force
    // upsert — anything else would clobber the prior chunk's inserts.
    const chunkMode: SyncMode = i === 0 ? (mode ?? "replace") : "upsert";
    const result = await shipChunk(
      config,
      rootPath,
      chunk,
      projectId,
      chunkMode,
    );
    if (!result.ok) {
      log.error("sync chunk failed — aborting bulk sync", {
        chunk: i + 1,
        totalChunks,
        chunkFiles: chunk.length,
        chunkMode,
        error: result.error,
      });
      return result;
    }
    log.debug("sync chunk OK", {
      chunk: i + 1,
      totalChunks,
      files: chunk.length,
      mode: chunkMode,
    });
  }

  log.info("sync OK (chunked)", {
    rootPath,
    totalFiles: parsedFiles.length,
    chunks: totalChunks,
  });
  return { ok: true as const };
};
