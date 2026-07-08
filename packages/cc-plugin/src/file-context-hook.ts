/**
 * File-context injection on Read — PreToolUse hook.
 *
 * Matched against the built-in `Read` tool. Before the model reads a
 * file, this hook builds cartographer info (symbols, imports,
 * dependents) from the LOCAL cart index and semantically-related
 * memories from the local replica (MIM-91 — no server round-trip), then
 * injects them as `additionalContext` alongside the tool_call so the
 * model frames the read with that knowledge.
 *
 * Dedup is hash-keyed, not path-keyed: the state file maps
 * `filePath → contentHash`, and re-injection happens only when the
 * index's content_hash differs from the cached value. That makes the
 * cache invalidate naturally after an Edit → reindex cycle (the
 * reindex worker updates the local index's content_hash, the next Read
 * sees a new hash, and re-injection fires).
 *
 * Never blocks the read. Empty index result (file not indexed) ⇒
 * skip injection without an error.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { buildLocalFileInfo } from "@mimir/plugin-core/cartographer/file-context";
import {
  getOrResolveProjectId,
  toProjectRelative,
} from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("file-context-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly cwd?: string;
};

type Symbol = {
  readonly kind: string;
  readonly name: string;
  readonly line: number;
};

type ImportEntry = { readonly target: string; readonly specifier: string };
type DependentEntry = { readonly source: string; readonly specifier: string };

type FileInfoResponse = {
  readonly contentHash?: string;
  readonly symbols?: readonly Symbol[];
  readonly imports?: readonly ImportEntry[];
  readonly dependents?: readonly DependentEntry[];
  readonly memories?: string | null;
  /** True memory count from the server. Older servers omit it. */
  readonly memoryCount?: number;
};

/**
 * Memory count for the summary line. Prefers the server's memoryCount;
 * against older servers that omit it, counts top-level bullets in the
 * formatted string. Memories are multi-line, so a bare line count would
 * report one memory as dozens (nested bullets can still inflate the
 * fallback — the field is the fix, this is the degraded mode).
 */
export const countMemories = (info: FileInfoResponse) => {
  if (typeof info.memoryCount === "number") return info.memoryCount;
  if (!info.memories) return 0;
  return info.memories.split("\n").filter((l) => l.startsWith("- ")).length;
};

type DedupCache = Record<string, string>;

const cachePath = (sessionId: string) =>
  join(mimirHome(), "file-context-state", `${sessionId}.json`);

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const safeParseHookInput = async (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  const [err, parsed] = await attempt(async () => JSON.parse(raw) as HookInput);
  return err ? ({} as HookInput) : parsed;
};

const extractFilePath = (input: HookInput) => {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return null;
  const fp = (ti as Record<string, unknown>).file_path;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
};

const readCache = async (sessionId: string) => {
  const file = Bun.file(cachePath(sessionId));
  if (!(await file.exists())) return {} as DedupCache;
  const [err, parsed] = await attempt(
    async () => (await file.json()) as DedupCache,
  );
  return err || !parsed || typeof parsed !== "object"
    ? ({} as DedupCache)
    : parsed;
};

const writeCache = async (sessionId: string, cache: DedupCache) => {
  const path = cachePath(sessionId);
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await Bun.write(path, JSON.stringify(cache));
};

const localFileInfo = async (
  rootPath: string,
  filePath: string,
  projectId: string | null,
) => {
  const [err, info] = await attempt(() =>
    buildLocalFileInfo({
      rootPath,
      filePath,
      projectId,
      // MIM-85 vector leg; cold/absent embedder degrades to FTS-only.
      embedQuery: createEmbedQuery(),
    }),
  );
  if (err) {
    log.warn("local file-info failed", { filePath, error: err.message });
    return null;
  }
  const payload: FileInfoResponse = info;
  return payload;
};

const renderSymbols = (symbols: readonly Symbol[]) => {
  if (symbols.length === 0) return "";
  const lines = symbols.map((s) => `- ${s.kind} ${s.name} (line ${s.line})`);
  return `<symbols>\n${lines.join("\n")}\n</symbols>`;
};

const renderImports = (imports: readonly ImportEntry[]) => {
  if (imports.length === 0) return "";
  const lines = imports.map((i) =>
    i.specifier && i.specifier !== i.target
      ? `- ${i.specifier} → ${i.target}`
      : `- ${i.target}`,
  );
  return `<imports>\n${lines.join("\n")}\n</imports>`;
};

const renderDependents = (dependents: readonly DependentEntry[]) => {
  if (dependents.length === 0) return "";
  const lines = dependents.map((d) => `- ${d.source}`);
  return `<dependents>\n${lines.join("\n")}\n</dependents>`;
};

const renderMemories = (memories: string | null | undefined) => {
  if (!memories || memories.length === 0) return "";
  return `<memories>\n${memories}\n</memories>`;
};

const buildBlock = (filePath: string, info: FileInfoResponse) => {
  const sections = [
    renderSymbols(info.symbols ?? []),
    renderImports(info.imports ?? []),
    renderDependents(info.dependents ?? []),
    renderMemories(info.memories),
  ].filter((s) => s.length > 0);
  if (sections.length === 0) return "";
  return `<file_context path="${filePath}">\n${sections.join("\n\n")}\n</file_context>`;
};

const emitInjection = (block: string, summary: string) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: block,
      },
      systemMessage: summary,
    }),
  );
};

/**
 * Entry point invoked from cli.ts when argv[2] === "file-context".
 *
 * Exit 0 unconditionally. PreToolUse non-zero exits would surface as a
 * tool error — losing context augmentation is much better than that.
 */
export const runFileContextHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);

  if (input.tool_name !== "Read") return 0;

  const sessionId = input.session_id ?? "default";
  const cwd = input.cwd ?? process.cwd();
  const filePath = extractFilePath(input);

  if (!filePath) {
    log.debug("no file_path in tool_input — skipping");
    return 0;
  }

  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping file-context");
    return 0;
  }

  // Resolve cwd → project UUID (disk-cached after the first hook of a
  // session). Used only as the memory-scoring tiebreaker — the cart
  // lookup itself is keyed by rootPath and needs no server at all.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    cwd,
    config.apiKey,
  ).catch(() => null);

  // Cart rows store project-relative paths. Query by the same
  // representation or every lookup misses. The dedup cache key uses the
  // relative form too — anything else would silently re-inject when CC
  // hands us the same file via a path that round-trips differently.
  const relativeFilePath = toProjectRelative(cwd, filePath);

  const info = await localFileInfo(cwd, relativeFilePath, projectId);
  if (!info) return 0;

  // File not in cartographer index — no contentHash, no content to inject.
  // Logged at INFO (not DEBUG) so missed-index reads are visible by
  // default; otherwise debugging "why isn't the hook firing on file X"
  // requires turning on MIMIR_DEBUG and replaying.
  if (!info.contentHash || info.contentHash.length === 0) {
    log.info("file not indexed by cartographer — skipping injection", {
      filePath,
      relativeFilePath,
    });
    return 0;
  }

  const cache = await readCache(sessionId);
  if (cache[relativeFilePath] === info.contentHash) {
    log.debug("file-context already injected for this hash", {
      filePath,
      relativeFilePath,
      hash: info.contentHash,
    });
    return 0;
  }

  const block = buildBlock(filePath, info);
  if (block.length === 0) {
    log.debug("file-info returned empty context — skipping injection", {
      filePath,
    });
    return 0;
  }

  const dependentCount = info.dependents?.length ?? 0;
  const memoryCount = countMemories(info);
  const summary = `↻ File context: ${dependentCount} dependents, ${memoryCount} memories`;

  emitInjection(block, summary);

  // Update cache only AFTER emitting — if anything above failed we'd
  // rather re-inject next time than silently skip with a stale entry.
  cache[relativeFilePath] = info.contentHash;
  await writeCache(sessionId, cache);

  log.info("file-context injected", {
    sessionId,
    filePath,
    relativeFilePath,
    projectId,
    contentHash: info.contentHash,
    symbols: info.symbols?.length ?? 0,
    imports: info.imports?.length ?? 0,
    dependents: dependentCount,
    hasMemories: !!info.memories,
    blockChars: block.length,
  });

  return 0;
};
