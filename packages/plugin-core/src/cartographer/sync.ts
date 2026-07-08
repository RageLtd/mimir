/**
 * Cartographer index sync — LOCAL since MIM-91.
 *
 * Takes the raw JSON output from the cartographer binary's --parse-only
 * mode and writes it to the local cart index (store/cart-index.ts). The
 * server sync endpoint is gone: code content is the most sensitive tenant
 * data category and never leaves the machine. The index is a derived
 * cache of files already on this disk — rebuild replaces sync.
 *
 * The old HTTP-era machinery (chunking for proxy body limits, API keys,
 * projectId resolution) died with the transport. rootPath is the index
 * key; no server round-trip exists on this path at all.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { createLoggerFactory } from "../logger";
import { attempt } from "../result";
import {
  type CartSyncFile,
  createCartIndex,
  defaultCartIndexPath,
} from "../store/cart-index";
import type { ParsedFileOutput } from "./client";

const log =
  createLoggerFactory("mimir-plugin").createLogger("cartographer-sync");

export type SyncMode = "replace" | "upsert";

const EXPORTED_VISIBILITIES = new Set(["exported", "default_export", "public"]);

/**
 * Compute SHA-256 hex of a file's contents. Returns an empty string when
 * the file isn't readable, when the path is missing from the parser
 * output, or when reading throws — the hash drives the file-context
 * dedup cache, and none of those conditions should abort the sync.
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

/**
 * Shape parser output into cart-index sync rows: content hashes computed,
 * exports derived from symbol visibility, columns defaulted.
 */
export const buildCartFiles = async (
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
) =>
  Promise.all(
    parsedFiles.map(async (file) => {
      const row: CartSyncFile = {
        path: file.file_path,
        language: file.language,
        imports: file.imports.map((entry) => ({
          target: entry.target,
          specifier: entry.specifier,
        })),
        exports: file.symbols
          .filter((symbol) => EXPORTED_VISIBILITIES.has(symbol.visibility))
          .map((symbol) => symbol.name),
        symbols: file.symbols.map((symbol) => ({
          kind: symbol.kind,
          name: symbol.name,
          line: symbol.line,
          column: 0,
        })),
        content_hash: await hashFile(rootPath, file.file_path),
      };
      return row;
    }),
  );

/**
 * Write parsed cartographer output to the local index.
 *
 * `mode` semantics match the old server contract:
 *   "upsert"  — only the files in this batch are replaced (single-file
 *               reindex won't wipe the project).
 *   "replace" — wipe the entire root's index then re-insert (full
 *               re-scans / SessionStart), which drops deleted files.
 */
export const syncIndex = async (
  rootPath: string,
  parsedFiles: readonly ParsedFileOutput[],
  mode: SyncMode = "replace",
) => {
  const files = await buildCartFiles(rootPath, parsedFiles);
  const [err] = await attempt(async () => {
    const index = createCartIndex(
      process.env.MIMIR_CART_INDEX_DB ?? defaultCartIndexPath(),
    );
    const result = index.syncFiles(rootPath, files, mode);
    index.close();
    return result;
  });
  if (err) {
    log.error("local index sync failed", { rootPath, error: err.message });
    return { ok: false as const, error: err.message };
  }
  log.info("local index sync OK", { rootPath, files: files.length, mode });
  return { ok: true as const };
};
