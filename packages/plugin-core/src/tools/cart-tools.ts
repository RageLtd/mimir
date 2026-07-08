/**
 * Local cartographer tools (MIM-91) — cartographer_search /
 * cartographer_file_info / cartographer_query served from the local cart
 * index. Names, parameter schemas, and result payload shapes mirror the
 * server's /mcp versions (agent/server-tools/cartographer.ts, retired)
 * so the model's habits carry over unchanged.
 *
 * The `project` parameter kept its "UUID, path, or git remote" wording
 * for schema parity, but the local index keys by rootPath: an absolute
 * path is used as-is, anything else auto-detects to the process cwd
 * (the mimir-local MCP is spawned in the project directory).
 */

import { isAbsolute } from "node:path";
import { attempt } from "../result";
import {
  type CartIndex,
  createCartIndex,
  defaultCartIndexPath,
} from "../store/cart-index";
import type { ToolDefinition } from "./user-memory";

const PROJECT_DESC =
  "Project identifier (UUID, path, or git remote). Omit to auto-detect.";

export const cartToolDefs: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "cartographer_search",
      description:
        "Search indexed codebase for files by path or symbol name. Omit project to auto-detect.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: PROJECT_DESC },
          query: {
            type: "string",
            description: "Search query — matches file paths and symbol names",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cartographer_file_info",
      description:
        "Get file details: symbols, imports, and dependents. Omit project to auto-detect.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: PROJECT_DESC },
          file_path: {
            type: "string",
            description: "Path to the file (project-relative or absolute)",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cartographer_query",
      description:
        "Walk import graph from entry points. Returns dependencies and dependents up to depth.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: PROJECT_DESC },
          entry_points: {
            type: "array",
            items: { type: "string" },
            description: "File paths or search terms to start from",
          },
          max_depth: {
            type: "number",
            description: "Maximum hops (default: 2)",
          },
          max_results: {
            type: "number",
            description: "Maximum files (default: 20)",
          },
        },
        required: ["entry_points"],
      },
    },
  },
];

const resolveRoot = (project: unknown) =>
  typeof project === "string" && isAbsolute(project) ? project : process.cwd();

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const runSearch = (
  index: CartIndex,
  rootPath: string,
  args: Record<string, unknown>,
) => {
  const query = str(args.query);
  if (!query) return { files: [], error: "Missing required field: query" };
  const files = index
    .searchFiles(rootPath, query, num(args.limit, 10))
    .map((f) => ({ path: f.path, language: f.language }));
  return { files, error: null };
};

const runFileInfo = async (
  index: CartIndex,
  rootPath: string,
  args: Record<string, unknown>,
) => {
  const filePath = str(args.file_path);
  const info = filePath ? await index.fileInfo(rootPath, filePath) : null;
  if (!info) {
    return {
      file_path: filePath,
      language: null,
      symbols: [],
      imports: [],
      dependents: [],
      error: `File not found: ${filePath}`,
    };
  }
  return {
    file_path: filePath,
    language: info.language,
    symbols: info.symbols,
    imports: info.imports,
    dependents: info.dependents,
    error: null,
  };
};

/** BFS over both edge directions — port of the server executeQuery walk. */
const runQuery = (
  index: CartIndex,
  rootPath: string,
  args: Record<string, unknown>,
) => {
  const entryPoints = Array.isArray(args.entry_points)
    ? args.entry_points.filter((e): e is string => typeof e === "string")
    : [];
  if (entryPoints.length === 0) {
    return { files: [], error: "Missing required field: entry_points" };
  }
  const maxDepth = num(args.max_depth, 2);
  const maxFiles = num(args.max_results, 20);

  // Entry points: literal paths pass through; search terms resolve via FTS.
  const resolvedPaths = entryPoints.flatMap((entry) =>
    entry.includes("/") || entry.includes(".")
      ? [entry]
      : index.searchFiles(rootPath, entry, 5).map((f) => f.path),
  );
  if (resolvedPaths.length === 0) {
    return { files: [], error: "No matching files found" };
  }

  const visited = new Map<string, { depth: number; reason: string }>();
  const queue: Array<{ path: string; depth: number }> = [];
  for (const entryPath of resolvedPaths) {
    if (!visited.has(entryPath)) {
      visited.set(entryPath, { depth: 0, reason: "entry" });
      queue.push({ path: entryPath, depth: 0 });
    }
  }

  for (let i = 0; i < queue.length && visited.size < maxFiles; i++) {
    const node = queue[i];
    if (!node || node.depth >= maxDepth) continue;
    const addNode = (path: string, reason: string) => {
      if (!visited.has(path) && visited.size < maxFiles) {
        visited.set(path, { depth: node.depth + 1, reason });
        queue.push({ path, depth: node.depth + 1 });
      }
    };
    for (const target of index.importsOf(rootPath, node.path)) {
      addNode(target, "dependency");
    }
    for (const source of index.dependentsOf(rootPath, node.path)) {
      addNode(source, "dependent");
    }
  }

  const files = Array.from(visited.entries())
    .sort((a, b) => a[1].depth - b[1].depth)
    .slice(0, maxFiles)
    .map(([path, nodeInfo]) => ({
      path,
      depth: nodeInfo.depth,
      reason: nodeInfo.reason,
    }));
  return { files, error: null };
};

export const cartToolNames = new Set(
  cartToolDefs.map((def) => def.function.name),
);

/**
 * Execute a cartographer tool against the local index. Result payloads
 * mirror the retired server tools; errors return as `{ isError, content }`
 * matching the org-memory executor contract.
 */
export const executeCartTool = async (
  name: string,
  args: Record<string, unknown>,
) => {
  const rootPath = resolveRoot(args.project);
  const [err, payload] = await attempt(async () => {
    const index = createCartIndex(
      process.env.MIMIR_CART_INDEX_DB ?? defaultCartIndexPath(),
    );
    const result = await (name === "cartographer_search"
      ? runSearch(index, rootPath, args)
      : name === "cartographer_file_info"
        ? runFileInfo(index, rootPath, args)
        : runQuery(index, rootPath, args));
    index.close();
    return result;
  });
  if (err) {
    return {
      isError: true as const,
      content: `${name} failed: ${err.message}`,
    };
  }
  return { isError: false as const, content: JSON.stringify(payload, null, 2) };
};
