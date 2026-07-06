/**
 * ACP cartographer client — wraps the shared plugin-core client with
 * three extra methods (`indexProject`, `detectChanges`, `stats`) that
 * the ACP's long-running session lifecycle uses for project indexing,
 * change detection, and stats queries.
 *
 * The shared client in @mimir/plugin-core provides the JSON-RPC
 * transport, the parseFile surface, and the spawn lifecycle. This
 * module extends that base with higher-level operations specific to
 * the ACP session manager.
 *
 * The public `CartographerClient` type matches what `lifecycle.ts` and
 * downstream consumers expect — the acp's local extended surface.
 * The shared base is a strict subset.
 */

import {
  type ParsedFileOutput,
  type CartographerClient as SharedCartographerClient,
  spawnCartographer as spawnShared,
} from "@mimir/plugin-core/cartographer/client";

// Re-export for consumers that import ParsedFileOutput from here.
export type { ParsedFileOutput };

export type DetectChangesOutput = {
  indexed: number;
  removed: number;
  modified: string[];
  deleted: string[];
};

export type StatsOutput = {
  totalFiles: number;
  totalImportEdges: number;
  languages: Record<string, number>;
};

/** ACP cartographer client surface — shared base + three extra methods. */
export type CartographerClient = SharedCartographerClient & {
  /** Run full project index. Returns the binary's text summary. */
  readonly indexProject: (project: string) => Promise<string>;
  /** Detect git changes and re-index. Returns structured output. */
  readonly detectChanges: (project: string) => Promise<DetectChangesOutput>;
  /** Get index stats. */
  readonly stats: (project: string) => Promise<StatsOutput>;
};

/**
 * Spawn the cartographer binary as an MCP server and return an ACP-
 * flavoured client. Wraps the shared spawn and layers the extra
 * methods on top.
 *
 * Errors from the shared spawn propagate; errors from the wrapped
 * method implementations are caught and returned as a degraded result
 * where the contract is "missing data" (e.g. `detect_changes` returns
 * plain text on no-op, which the binary sometimes emits).
 */
export const spawnCartographer = async (
  binaryPath: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<CartographerClient> => {
  const shared = await spawnShared(binaryPath, cwd, env);

  const indexProject = (project: string): Promise<string> =>
    shared.callTool("cartographer_index_project", { project });

  const detectChanges = async (
    project: string,
  ): Promise<DetectChangesOutput> => {
    const text = await shared.callTool("cartographer_detect_changes", {
      project,
    });
    // detect_changes returns either plain text ("No changes") or JSON.
    // JSON.parse throws on the text case — let the caller see the
    // exception shape, don't try to be clever about silent fallback.
    return JSON.parse(text) as DetectChangesOutput;
  };

  const stats = async (project: string): Promise<StatsOutput> => {
    const text = await shared.callTool("cartographer_stats", { project });
    return JSON.parse(text) as StatsOutput;
  };

  return { ...shared, indexProject, detectChanges, stats };
};
