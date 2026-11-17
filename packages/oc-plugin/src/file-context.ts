/**
 * File-context — cartographer-aware augmentation of the `read` tool's
 * output. Mirrors the cc-plugin's PreToolUse:Read hook (which
 * injects a `<file_context>` block alongside the file contents) but
 * adapted to OpenCode's event model.
 *
 * OpenCode's `read` tool returns the file content as a string in
 * `output.output`. We build file-info (symbols, imports, dependents,
 * related memories) from the LOCAL cart index and replica (MIM-91 —
 * no server round-trip) and append a rendered `<file_context>` block
 * to the output, so the model reads the cartographer context alongside
 * the file contents.
 *
 * A per-session content-hash cache skips the rebuild when the file
 * hasn't changed since the last read. The local index stores the
 * file's content_hash, so the comparison is exact.
 */

import {
  countMemories,
  type FileInfoResponse,
  lookupFileInfo,
  renderFileContext,
} from "@mimir/plugin-core/cartographer/file-context-render";
import type { Logger } from "@mimir/plugin-core/logger";
import {
  getOrResolveProjectId,
  toProjectRelative,
} from "@mimir/plugin-core/project";
import { errMessage } from "@mimir/plugin-core/util";
import type { MimirConfig } from "./config";

// ── OpenCode read tool shape (narrow) ──

type ReadToolInput = {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
};

type ReadToolOutput = {
  readonly title: string;
  // Mutable: the real `tool.execute.after` hook output exposes `output`
  // as a writable string — we append the <file_context> block to it.
  output: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

// ── Cache ──

type CacheEntry = {
  readonly hash: string;
  readonly block: string;
};

type FileContextCache = Map<string, CacheEntry>;

/**
 * Per-session cache of file paths to (hash, rendered-block). Cleared
 * by clearing the whole Map at session boundary; the lifetime of
 * one Map is one plugin entry closure, which the runtime keeps alive
 * for the lifetime of the OpenCode process. In practice that means
 * the cache persists across `session.idle` events for the lifetime
 * of the user's OpenCode session — exactly the right scope.
 */
const createFileContextCache = (): FileContextCache => new Map();

// ── Public entry ──

/**
 * Augment the `read` tool's output with cartographer context. Returns
 * a new `output.output` string with the `<file_context>` block
 * appended (or the original string if the augmentation fails / is
 * skipped / yields an empty block).
 *
 * Cache invalidation: if the cartographer reports a different
 * content_hash than the cached entry, the cache entry is replaced
 * with the freshly-built block.
 */
export const augmentReadOutput = async (
  input: ReadToolInput,
  output: ReadToolOutput,
  projectPath: string,
  config: MimirConfig,
  log: Logger,
  cache: FileContextCache,
): Promise<void> => {
  // Only augment the read tool. Other tools (write, edit, bash, etc.)
  // pass through unchanged.
  if (input.tool !== "read") return;

  const filePath = input.args.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) return;

  // Project id resolves via the shared plugin-core helper. Failure
  // here is non-fatal — we just persist the project path as the
  // legacy fallback key.
  let projectId: string | null = null;
  try {
    projectId = await getOrResolveProjectId(
      config.serverUrl,
      projectPath,
      config.apiKey,
    );
  } catch (err) {
    log.warn("project id resolve failed for file-context", {
      filePath,
      error: errMessage(err),
    });
  }

  // The index stores project-relative paths — normalize before lookup.
  const relativeFilePath = toProjectRelative(projectPath, filePath);
  const cached = cache.get(filePath);
  const info = await lookupFileInfo({
    rootPath: projectPath,
    filePath: relativeFilePath,
    projectId,
    log,
  });
  if (!info) return;

  // File not in the cartographer index yet — nothing to augment.
  if (!info.contentHash || info.contentHash.length === 0) return;

  // Cache hit: same hash as the previous read, skip the augmentation.
  if (cached && cached.hash === info.contentHash) return;

  const block = renderFileContext(filePath, info);
  if (block.length === 0) {
    // No content to add, but we still cache the hash so we don't
    // re-render the empty block on every read.
    cache.set(filePath, { hash: info.contentHash, block: "" });
    return;
  }

  const dependentCount = info.dependents?.length ?? 0;
  const memoryCount = countMemories(info);
  log.info("file-context injected", {
    filePath,
    hash: info.contentHash,
    symbols: info.symbols?.length ?? 0,
    imports: info.imports?.length ?? 0,
    dependents: dependentCount,
    memoryCount,
  });

  output.output = `${output.output}\n\n${block}`;
  cache.set(filePath, { hash: info.contentHash, block });
};

export type { FileContextCache, FileInfoResponse };
export { createFileContextCache, renderFileContext };
