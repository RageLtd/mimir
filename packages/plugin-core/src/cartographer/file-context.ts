/**
 * Local file-info builder (MIM-91) — the shared replacement for the
 * server's /v1/cartographer/file-info route. Combines the local cart
 * index (symbols, imports, dependents, content hash) with replica
 * memories (filepath + top symbol names as the retrieval query — crude
 * but useful, verbatim from the server's heuristic).
 *
 * Response shape is byte-compatible with the old route so the cc/oc
 * file-context hooks keep their rendering and hash-dedup logic
 * untouched. Empty shape on miss — hooks treat absence as "skip
 * injection", never as an error.
 */

import {
  type EmbedQuery,
  formatMemoryList,
  retrieveMemoryList,
} from "../brain/retrieve";
import { attempt } from "../result";
import { createCartIndex, defaultCartIndexPath } from "../store/cart-index";
import { createOrgReplica, defaultOrgReplicaPath } from "../store/org-replica";

// Server-parity caps (old routes/cartographer-file-info.ts).
const FILE_INFO_MEMORY_SYMBOL_LIMIT = 5;
const FILE_INFO_MEMORY_TOP_K = 3;

export type LocalFileInfo = {
  readonly contentHash: string;
  readonly symbols: readonly { kind: string; name: string; line: number }[];
  readonly imports: readonly { target: string; specifier: string }[];
  readonly dependents: readonly { source: string; specifier: string }[];
  readonly memories: string | null;
  readonly memoryCount: number;
};

const EMPTY: LocalFileInfo = {
  contentHash: "",
  symbols: [],
  imports: [],
  dependents: [],
  memories: null,
  memoryCount: 0,
};

export type LocalFileInfoOpts = {
  readonly rootPath: string;
  /** Project-relative file path — the canonical index key. */
  readonly filePath: string;
  /** Canonical project UUID for the memory-scoring tiebreaker. */
  readonly projectId?: string | null;
  /** Vector leg for the memory search; null/omitted → FTS-only. */
  readonly embedQuery?: EmbedQuery | null;
};

/**
 * Build the file-context payload from local stores. Cart index miss →
 * the empty shape. Memory retrieval failure is non-fatal — the
 * cartographer half still serves (same posture as the old route).
 */
export const buildLocalFileInfo = async (opts: LocalFileInfoOpts) => {
  const [indexErr, info] = await attempt(async () => {
    const index = createCartIndex(
      process.env.MIMIR_CART_INDEX_DB ?? defaultCartIndexPath(),
    );
    const result = await index.fileInfo(opts.rootPath, opts.filePath);
    index.close();
    return result;
  });
  if (indexErr || !info) return EMPTY;

  const memoryQuery = [
    opts.filePath,
    ...info.symbols
      .slice(0, FILE_INFO_MEMORY_SYMBOL_LIMIT)
      .map((s) => s.name)
      .filter((n) => typeof n === "string" && n.length > 0),
  ].join(" ");

  const [memErr, memoryList] = await attempt(async () => {
    const replica = createOrgReplica(
      process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
    );
    const list = await retrieveMemoryList(replica, memoryQuery, {
      topK: FILE_INFO_MEMORY_TOP_K,
      includeRelated: false,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}),
    });
    replica.close();
    return list;
  });
  const memories = memErr || !memoryList ? null : memoryList;

  const result: LocalFileInfo = {
    contentHash: info.contentHash,
    symbols: info.symbols,
    imports: info.imports,
    dependents: info.dependents,
    memories: memories ? formatMemoryList(memories) : null,
    memoryCount: memories?.length ?? 0,
  };
  return result;
};
