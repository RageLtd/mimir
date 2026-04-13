import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../../db/surreal";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SearchSchema = z.object({
  project: z
    .string()
    .optional()
    .describe("Project root path. Omit to auto-detect."),
  query: z
    .string()
    .describe("Search query — matches file paths and symbol names"),
  limit: z.number().optional().describe("Maximum results (default: 10)"),
});

const FileInfoSchema = z.object({
  project: z
    .string()
    .optional()
    .describe("Project root path. Omit to auto-detect."),
  file_path: z.string().describe("Absolute path to the file"),
});

const QuerySchema = z.object({
  project: z
    .string()
    .optional()
    .describe("Project root path. Omit to auto-detect."),
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
function parseJson<T>(fallback: T): (str: string | null | undefined) => T {
  return (str: string | null | undefined): T => {
    if (!str) return fallback;
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  };
}

interface ProjectResolution {
  project: string;
  error: string | null;
}

async function resolveProject(project?: string): Promise<ProjectResolution> {
  if (project) return { project, error: null };

  const db = await getDb();
  const [result] = await db.query<[Array<{ project: string; count: number }>]>(
    `SELECT project, count() AS count FROM cart_file GROUP BY project`,
  );

  const projects = result ?? [];

  if (projects.length === 0) {
    return {
      project: "",
      error:
        "No projects indexed. Cartographer auto-indexes when launched from Zed.",
    };
  }

  if (projects.length === 1) {
    return { project: projects[0]?.project ?? "", error: null };
  }

  const list = projects
    .map(
      (projectRow) => `  - ${projectRow.project} (${projectRow.count} files)`,
    )
    .join("\n");
  return { project: "", error: `Multiple projects. Specify one:\n${list}` };
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

const executeSearch = async ({
  project,
  query,
  limit,
}: z.infer<typeof SearchSchema>) => {
  const resolved = await resolveProject(project);
  if (resolved.error) return { files: [], error: resolved.error };

  const db = await getDb();
  const maxResults = limit ?? 10;

  const [result] = await db.query<
    [Array<{ file_path: string; symbols: string }>]
  >(
    `SELECT file_path, symbols FROM cart_file
     WHERE project = $project AND searchable @1@ $query
     ORDER BY search::score(1) DESC LIMIT $limit`,
    { project: resolved.project, query, limit: maxResults },
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

const executeFileInfo = async ({
  project,
  file_path,
}: z.infer<typeof FileInfoSchema>) => {
  const resolved = await resolveProject(project);
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

  const db = await getDb();

  const [fileResult] = await db.query<
    [Array<{ language: string; symbols: string }>]
  >(
    `SELECT language, symbols FROM cart_file
     WHERE project = $project AND file_path = $file_path LIMIT 1`,
    { project: resolved.project, file_path },
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
    db.query<[Array<{ target_path: string; symbols: string }>]>(
      `SELECT target_path, symbols FROM cart_import WHERE project = $project AND source_path = $file_path`,
      { project: resolved.project, file_path },
    ),
    db.query<[Array<{ source_path: string; symbols: string }>]>(
      `SELECT source_path, symbols FROM cart_import WHERE project = $project AND target_path = $file_path`,
      { project: resolved.project, file_path },
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

const executeQuery = async ({
  project,
  entry_points,
  max_depth,
  max_results,
}: z.infer<typeof QuerySchema>) => {
  const resolved = await resolveProject(project);
  if (resolved.error) return { files: [], error: resolved.error };

  const db = await getDb();
  const maxDepth = max_depth ?? 2;
  const maxFiles = max_results ?? 20;

  // Resolve entry points (paths or search terms)
  const resolvedPaths = await Promise.all(
    entry_points.map(async (entryPoint) =>
      entryPoint.startsWith("/")
        ? [entryPoint]
        : db
            .query<[Array<{ file_path: string }>]>(
              `SELECT file_path FROM cart_file WHERE project = $project AND searchable @1@ $query LIMIT 5`,
              { project: resolved.project, query: entryPoint },
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
      db.query<[Array<{ target_path: string }>]>(
        `SELECT target_path FROM cart_import WHERE project = $project AND source_path = $source`,
        { project: resolved.project, source: currentNode.path },
      ),
      db.query<[Array<{ source_path: string }>]>(
        `SELECT source_path FROM cart_import WHERE project = $project AND target_path = $target`,
        { project: resolved.project, target: currentNode.path },
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

export const cartographerTools = {
  // cartographer_list_projects removed — project resolution is now handled
  // automatically by the session_start lifecycle hook in hooks/session.ts.

  cartographer_search: tool({
    description:
      "Search indexed codebase for files by path or symbol name. Omit project to auto-detect.",
    inputSchema: SearchSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeSearch,
  }),

  cartographer_file_info: tool({
    description:
      "Get file details: symbols, imports, and dependents. Omit project to auto-detect.",
    inputSchema: FileInfoSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeFileInfo,
  }),

  cartographer_query: tool({
    description:
      "Walk import graph from entry points. Returns dependencies and dependents up to depth.",
    inputSchema: QuerySchema,
    providerOptions: CACHE_CONTROL,
    execute: executeQuery,
  }),
};
