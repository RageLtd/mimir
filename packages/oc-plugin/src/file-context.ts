/**
 * File-context — cartographer-aware augmentation of the `read` tool's
 * output. Mirrors the cc-plugin's PreToolUse:Read hook (which
 * injects a `<file_context>` block alongside the file contents) but
 * adapted to OpenCode's event model.
 *
 * OpenCode's `read` tool returns the file content as a string in
 * `output.output`. We fetch the cartographer's file-info (symbols,
 * imports, dependents, related memories) and append a rendered
 * `<file_context>` block to the output, so the model reads the
 * cartographer context alongside the file contents.
 *
 * A per-session content-hash cache skips the round-trip when the
 * file hasn't changed since the last read. The cartographer's
 * `/v1/cartographer/file-info` response includes the file's
 * content_hash, so the comparison is exact.
 */

import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { errMessage } from "@mimir/plugin-core/util";
import { authHeaders, type MimirConfig } from "./config";

const FILE_INFO_ROUTE = "/v1/cartographer/file-info";

// ── Response shape (narrow) ──

type FileInfoResponse = {
  readonly contentHash?: string;
  readonly symbols?: ReadonlyArray<{
    readonly kind: string;
    readonly name: string;
    readonly line: number;
  }>;
  readonly imports?: ReadonlyArray<{
    readonly target: string;
    readonly specifier: string;
  }>;
  readonly dependents?: ReadonlyArray<{
    readonly source: string;
    readonly specifier: string;
  }>;
  readonly memories?: string | null;
  readonly memoryCount?: number;
};

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

// ── Render ──

const renderSymbols = (
  symbols: NonNullable<FileInfoResponse["symbols"]>,
): string => {
  if (symbols.length === 0) return "";
  const lines = symbols.map((s) => `- ${s.kind} ${s.name} (line ${s.line})`);
  return `<symbols>\n${lines.join("\n")}\n</symbols>`;
};

const renderImports = (
  imports: NonNullable<FileInfoResponse["imports"]>,
): string => {
  if (imports.length === 0) return "";
  const lines = imports.map((i) =>
    i.specifier && i.specifier !== i.target
      ? `- ${i.specifier} → ${i.target}`
      : `- ${i.target}`,
  );
  return `<imports>\n${lines.join("\n")}\n</imports>`;
};

const renderDependents = (
  dependents: NonNullable<FileInfoResponse["dependents"]>,
): string => {
  if (dependents.length === 0) return "";
  const lines = dependents.map((d) => `- ${d.source}`);
  return `<dependents>\n${lines.join("\n")}\n</dependents>`;
};

const renderMemories = (memories: string | null | undefined): string => {
  if (!memories || memories.length === 0) return "";
  return `<memories>\n${memories}\n</memories>`;
};

const countMemories = (info: FileInfoResponse): number => {
  if (typeof info.memoryCount === "number") return info.memoryCount;
  if (!info.memories) return 0;
  return info.memories.split("\n").filter((l) => l.startsWith("- ")).length;
};

const renderFileContext = (
  filePath: string,
  info: FileInfoResponse,
): string => {
  const sections = [
    renderSymbols(info.symbols ?? []),
    renderImports(info.imports ?? []),
    renderDependents(info.dependents ?? []),
    renderMemories(info.memories),
  ].filter((s) => s.length > 0);
  if (sections.length === 0) return "";
  return `<file_context path="${filePath}">\n${sections.join("\n\n")}\n</file_context>`;
};

// ── Fetch ──

/**
 * POST to /v1/cartographer/file-info. Returns null on any failure —
 * the caller treats that as "no context available, don't augment".
 */
const fetchFileInfo = async (
  config: MimirConfig,
  project: string,
  filePath: string,
  projectId: string | null,
): Promise<FileInfoResponse | null> => {
  const url = `${config.serverUrl.replace(/\/+$/, "")}${FILE_INFO_ROUTE}`;
  const headers = await authHeaders();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        project,
        filePath,
        ...(projectId ? { projectId } : {}),
      }),
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as FileInfoResponse | null;
  } catch {
    return null;
  }
};

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
  log: {
    readonly debug: (message: string, context?: unknown) => void;
    readonly info: (message: string, context?: unknown) => void;
    readonly warn: (message: string, context?: unknown) => void;
    readonly error: (message: string, context?: unknown) => void;
  },
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

  const cached = cache.get(filePath);
  const info = await fetchFileInfo(config, projectPath, filePath, projectId);
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
