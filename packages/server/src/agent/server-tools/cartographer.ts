import { tool } from "ai";
import { z } from "zod";
import type { OrgScope } from "../../db/scope";
import { resolveProjectForQuery } from "../../projects/resolve-for-query";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PROJECT_DESC =
  "Project identifier (UUID, path, or git remote). Omit to auto-detect.";

export const SearchSchema = z.object({
  project: z.string().optional().describe(PROJECT_DESC),
  query: z
    .string()
    .describe("Search query — matches file paths and symbol names"),
  limit: z.number().optional().describe("Maximum results (default: 10)"),
});

export const FileInfoSchema = z.object({
  project: z.string().optional().describe(PROJECT_DESC),
  file_path: z.string().describe("Absolute path to the file"),
});

export const QuerySchema = z.object({
  project: z.string().optional().describe(PROJECT_DESC),
  entry_points: z
    .array(z.string())
    .describe("File paths or search terms to start from"),
  max_depth: z.number().optional().describe("Maximum hops (default: 2)"),
  max_results: z.number().optional().describe("Maximum files (default: 20)"),
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Safe JSON parse with fallback */
function parseJson<T>(fallback: T) {
  return (str: string | null | undefined) => {
    if (!str) return fallback;
    try {
      return JSON.parse(str) as T;
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "parseJson failed, using fallback",
      );
      return fallback;
    }
  };
}

/**
 * Resolve a project identifier for cart queries. Delegates to the
 * canonical resolver which tries ID → git remote → path → raw fallback,
 * scoped to the caller's org.
 */
async function resolveProject(scope: OrgScope, project?: string) {
  return resolveProjectForQuery(scope, project);
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

export const executeSearch = async (
  scope: OrgScope,
  { project, query, limit }: z.infer<typeof SearchSchema>,
) => {
  const resolved = await resolveProject(scope, project);
  if (resolved.error) return { files: [], error: resolved.error };

  const maxResults = limit ?? 10;

  const [result] = await scope.db.query<
    [Array<{ file_path: string; symbols: string; score: number }>]
  >(
    `SELECT file_path, symbols, search::score(1) AS score FROM cart_file
     WHERE project_id = $project_id AND org_id = $scope_org AND searchable @1@ $query
     ORDER BY score DESC LIMIT $limit`,
    {
      project_id: resolved.project,
      query,
      limit: maxResults,
      scope_org: scope.orgId,
    },
  );

  const files = (result ?? []).map((fileRow) => ({
    path: fileRow.file_path,
    symbols: parseJson<string[]>([])(fileRow.symbols),
  }));

  log.info(
    { query, project: resolved.project, results: files.length },
    "cartographer_search",
  );
  return { files, error: null };
};

export const executeFileInfo = async (
  scope: OrgScope,
  { project, file_path }: z.infer<typeof FileInfoSchema>,
) => {
  const resolved = await resolveProject(scope, project);
  if (resolved.error) {
    return {
      file_path,
      language: null,
      symbols: [],
      imports: [],
      dependents: [],
      error: resolved.error,
    };
  }

  const [fileResult] = await scope.db.query<
    [Array<{ language: string; symbols: string }>]
  >(
    `SELECT language, symbols FROM cart_file
     WHERE project_id = $project_id AND org_id = $scope_org AND file_path = $file_path LIMIT 1`,
    { project_id: resolved.project, file_path, scope_org: scope.orgId },
  );

  const file = fileResult?.[0];
  if (!file) {
    return {
      file_path,
      language: null,
      symbols: [],
      imports: [],
      dependents: [],
      error: `File not found: ${file_path}`,
    };
  }

  const [imports, dependents] = await Promise.all([
    scope.db.query<[Array<{ target_path: string; symbols: string }>]>(
      `SELECT target_path, symbols FROM cart_import WHERE project_id = $project_id AND org_id = $scope_org AND source_path = $file_path`,
      { project_id: resolved.project, file_path, scope_org: scope.orgId },
    ),
    scope.db.query<[Array<{ source_path: string; symbols: string }>]>(
      `SELECT source_path, symbols FROM cart_import WHERE project_id = $project_id AND org_id = $scope_org AND target_path = $file_path`,
      { project_id: resolved.project, file_path, scope_org: scope.orgId },
    ),
  ]);

  const result = {
    file_path,
    language: file.language,
    symbols: parseJson<string[]>([])(file.symbols),
    imports: (imports[0] ?? []).map((importRow) => ({
      target: importRow.target_path,
      symbols: parseJson<string[]>([])(importRow.symbols),
    })),
    dependents: (dependents[0] ?? []).map((dependentRow) => ({
      source: dependentRow.source_path,
      symbols: parseJson<string[]>([])(dependentRow.symbols),
    })),
    error: null,
  };

  log.info(
    {
      file_path,
      imports: result.imports.length,
      dependents: result.dependents.length,
    },
    "cartographer_file_info",
  );
  return result;
};

export const executeQuery = async (
  scope: OrgScope,
  {
    project,
    entry_points,
    max_depth,
    max_results,
  }: z.infer<typeof QuerySchema>,
) => {
  const resolved = await resolveProject(scope, project);
  if (resolved.error) return { files: [], error: resolved.error };

  const maxDepth = max_depth ?? 2;
  const maxFiles = max_results ?? 20;

  // Resolve entry points (paths or search terms)
  const resolvedPaths = await Promise.all(
    entry_points.map(async (entryPoint) =>
      entryPoint.startsWith("/")
        ? [entryPoint]
        : scope.db
            .query<[Array<{ file_path: string }>]>(
              `SELECT file_path FROM cart_file WHERE project_id = $project_id AND org_id = $scope_org AND searchable @1@ $query LIMIT 5`,
              {
                project_id: resolved.project,
                query: entryPoint,
                scope_org: scope.orgId,
              },
            )
            .then((queryResult) =>
              (queryResult[0] ?? []).map((fileRow) => fileRow.file_path),
            ),
    ),
  ).then((pathArrays) => pathArrays.flat());

  if (resolvedPaths.length === 0) {
    return { files: [], error: "No matching files found" };
  }

  // BFS graph walk
  const visited = new Map<string, { depth: number; reason: string }>();
  const queue: Array<{ path: string; depth: number; reason: string }> = [];

  resolvedPaths.forEach((entryPath) => {
    if (!visited.has(entryPath)) {
      visited.set(entryPath, { depth: 0, reason: "entry" });
      queue.push({ path: entryPath, depth: 0, reason: "entry" });
    }
  });

  for (
    let queueIndex = 0;
    queueIndex < queue.length && visited.size < maxFiles;
    queueIndex++
  ) {
    const currentNode = queue[queueIndex];
    if (!currentNode || currentNode.depth >= maxDepth) continue;

    const [dependencies, importers] = await Promise.all([
      scope.db.query<[Array<{ target_path: string }>]>(
        `SELECT target_path FROM cart_import WHERE project_id = $project_id AND org_id = $scope_org AND source_path = $source`,
        {
          project_id: resolved.project,
          source: currentNode.path,
          scope_org: scope.orgId,
        },
      ),
      scope.db.query<[Array<{ source_path: string }>]>(
        `SELECT source_path FROM cart_import WHERE project_id = $project_id AND org_id = $scope_org AND target_path = $target`,
        {
          project_id: resolved.project,
          target: currentNode.path,
          scope_org: scope.orgId,
        },
      ),
    ]);

    const addNode = (path: string, reason: string) => {
      if (!visited.has(path) && visited.size < maxFiles) {
        visited.set(path, { depth: currentNode.depth + 1, reason });
        queue.push({ path, depth: currentNode.depth + 1, reason });
      }
    };

    for (const dependency of dependencies[0] ?? []) {
      addNode(dependency.target_path, "dependency");
    }
    for (const importer of importers[0] ?? []) {
      addNode(importer.source_path, "dependent");
    }
  }

  const files = Array.from(visited.entries())
    .sort((first, second) => first[1].depth - second[1].depth)
    .slice(0, maxFiles)
    .map(([path, nodeInfo]) => ({
      path: path.startsWith(resolved.project)
        ? path.slice(resolved.project.length).replace(/^\//, "")
        : path,
      depth: nodeInfo.depth,
      reason: nodeInfo.reason,
    }));

  log.info(
    { entry_points, maxDepth, results: files.length },
    "cartographer_query",
  );
  return { files, error: null };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Build the cartographer tool group bound to an org scope. Rebuilt per request
 * so each tool's execute closes over the caller's OrgScope (MIM-69) — the cart_*
 * tables are org-scoped, so the closure carries the tenant boundary the tool()
 * execute signature can't.
 */
export function buildCartographerTools(scope: OrgScope) {
  return {
    // cartographer_list_projects removed — project resolution is now handled
    // automatically by the session_start lifecycle hook in hooks/session.ts.

    cartographer_search: tool({
      description:
        "Search indexed codebase for files by path or symbol name. Omit project to auto-detect.",
      inputSchema: SearchSchema,
      providerOptions: CACHE_CONTROL,
      execute: (args: z.infer<typeof SearchSchema>) =>
        executeSearch(scope, args),
    }),

    cartographer_file_info: tool({
      description:
        "Get file details: symbols, imports, and dependents. Omit project to auto-detect.",
      inputSchema: FileInfoSchema,
      providerOptions: CACHE_CONTROL,
      execute: (args: z.infer<typeof FileInfoSchema>) =>
        executeFileInfo(scope, args),
    }),

    cartographer_query: tool({
      description:
        "Walk import graph from entry points. Returns dependencies and dependents up to depth.",
      inputSchema: QuerySchema,
      providerOptions: CACHE_CONTROL,
      execute: (args: z.infer<typeof QuerySchema>) => executeQuery(scope, args),
    }),
  };
}
