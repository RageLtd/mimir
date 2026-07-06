/**
 * Cartographer index sync to mimir-server.
 *
 * Forwards the raw JSON output from the cartographer binary's --parse-only
 * mode to mimir-server's sync endpoint. The server persists to SurrealDB
 * so query tools (search, graph walk, file info) work cross-project.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { errMessage } from "@mimir/plugin-core/util";
import type { Logger } from "../utils/log";
import type { ParsedFileOutput } from "./client";

export type CartographerSyncConfig = {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly logger: Logger;
};

type IndexPayload = {
  readonly rootPath: string;
  readonly projectId?: string;
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

export const buildIndexPayload = async (
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
  projectId?: string | null,
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
 * Post parsed cartographer output to the server sync endpoint.
 * When `projectId` is provided, it's injected into the payload so the
 * server keys cart records by the canonical project UUID. Otherwise the
 * server falls back to using `rootPath` (legacy behaviour).
 */
export const syncIndex = async (
  config: CartographerSyncConfig,
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
  projectId?: string | null,
) => {
  const url = `${config.serverUrl}/v1/cartographer/sync`;
  const payload = await buildIndexPayload(rootPath, parsedFiles, projectId);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    const message = errMessage(err);
    config.logger.error(`Cartographer sync error: ${message}`);
    return null;
  });
  if (!response) return { ok: false, error: "network error" };

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    config.logger.error(
      `Cartographer sync failed: ${response.status} ${errText}`,
    );
    return { ok: false, error: `${response.status}: ${errText}` };
  }

  config.logger.info(
    `Cartographer sync OK: ${payload.rootPath} (${payload.files.length} files)`,
  );
  return { ok: true };
};
