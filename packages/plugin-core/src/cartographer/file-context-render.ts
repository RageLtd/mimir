/**
 * File-context rendering shared by every host's read hook: the local
 * file-info lookup, the `<file_context>` block and the status-line
 * summary. Hosts keep their own dedup, read-tool detection and output
 * envelope; what goes into the model's context is decided here, once.
 */

import { createEmbedQuery } from "../brain/embedder";
import type { EmbedQuery } from "../brain/retrieve";
import type { Logger } from "../logger";
import { attempt } from "../result";
import {
  buildLocalFileInfo,
  type LocalFileInfo,
  type LocalFileInfoOpts,
} from "./file-context";

type Symbol = {
  readonly kind: string;
  readonly name: string;
  readonly line: number;
};

type ImportEntry = { readonly target: string; readonly specifier: string };
type DependentEntry = { readonly source: string; readonly specifier: string };

/** File-info as the hooks read it; every field optional so a miss renders nothing. */
export type FileInfoResponse = {
  readonly contentHash?: string;
  readonly symbols?: readonly Symbol[];
  readonly imports?: readonly ImportEntry[];
  readonly dependents?: readonly DependentEntry[];
  readonly memories?: string | null;
  /** True memory count. Older payloads omit it. */
  readonly memoryCount?: number;
};

const MEMORY_BULLET = "- ";

/**
 * Memory count for the summary line. Prefers memoryCount; when it is
 * absent, counts top-level bullets in the formatted string. Memories are
 * multi-line, so a bare line count would report one memory as dozens
 * (nested bullets can still inflate the fallback — the field is the fix,
 * this is the degraded mode).
 */
export const countMemories = (info: FileInfoResponse) => {
  if (typeof info.memoryCount === "number") return info.memoryCount;
  if (!info.memories) return 0;
  return info.memories.split("\n").filter((l) => l.startsWith(MEMORY_BULLET))
    .length;
};

/** The "↻ File context" status line. */
export const fileContextSummary = (info: FileInfoResponse) =>
  `↻ File context: ${info.dependents?.length ?? 0} dependents, ${countMemories(info)} memories`;

const section = (tag: string, lines: readonly string[]) =>
  lines.length === 0 ? "" : `<${tag}>\n${lines.join("\n")}\n</${tag}>`;

const renderSymbols = (symbols: readonly Symbol[]) =>
  section(
    "symbols",
    symbols.map((s) => `- ${s.kind} ${s.name} (line ${s.line})`),
  );

const renderImports = (imports: readonly ImportEntry[]) =>
  section(
    "imports",
    imports.map((i) =>
      i.specifier && i.specifier !== i.target
        ? `- ${i.specifier} → ${i.target}`
        : `- ${i.target}`,
    ),
  );

const renderDependents = (dependents: readonly DependentEntry[]) =>
  section(
    "dependents",
    dependents.map((d) => `- ${d.source}`),
  );

const renderMemories = (memories: string | null | undefined) =>
  section("memories", memories ? [memories] : []);

/** The `<file_context>` block for `filePath`; empty when every section is. */
export const renderFileContext = (filePath: string, info: FileInfoResponse) => {
  const sections = [
    renderSymbols(info.symbols ?? []),
    renderImports(info.imports ?? []),
    renderDependents(info.dependents ?? []),
    renderMemories(info.memories),
  ].filter((s) => s.length > 0);
  if (sections.length === 0) return "";
  return `<file_context path="${filePath}">\n${sections.join("\n\n")}\n</file_context>`;
};

export type LookupFileInfoOpts = {
  readonly rootPath: string;
  /** Project-relative file path — the cart index key. */
  readonly filePath: string;
  readonly projectId: string | null;
  readonly log: Logger;
};

export type LookupFileInfoDeps = {
  readonly buildLocalFileInfo: (
    opts: LocalFileInfoOpts,
  ) => Promise<LocalFileInfo>;
  readonly createEmbedQuery: () => EmbedQuery;
};

const DEFAULT_DEPS: LookupFileInfoDeps = {
  buildLocalFileInfo,
  createEmbedQuery,
};

/**
 * File-info from the local cart index and replica. Null (with a warning
 * naming the file and the error) when the lookup fails — the caller
 * treats that as "no context available", never as a failed read.
 */
export const lookupFileInfo = async (
  opts: LookupFileInfoOpts,
  deps: LookupFileInfoDeps = DEFAULT_DEPS,
) => {
  const [err, info] = await attempt(() =>
    deps.buildLocalFileInfo({
      rootPath: opts.rootPath,
      filePath: opts.filePath,
      projectId: opts.projectId,
      // MIM-85 vector leg; a cold or absent embedder gives no memories.
      embedQuery: deps.createEmbedQuery(),
    }),
  );
  if (err) {
    opts.log.warn("local file-info failed", {
      filePath: opts.filePath,
      error: err.message,
    });
    return null;
  }
  const payload: FileInfoResponse = info;
  return payload;
};
