import { tool } from "ai";
import { z } from "zod";
import { embedOne, rerank } from "../../goldfish/clients";
import type { Memory } from "../../goldfish/store";
import {
  createRelation,
  deleteMemory,
  findDuplicate,
  findNeighbors,
  listMemories,
  searchByText,
  searchByVector,
  storeMemory,
  updateMemory,
} from "../../goldfish/store";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MemorySearchSchema = z.object({
  query: z
    .string()
    .describe("Search query — keywords or natural language question"),
  limit: z.number().optional().describe("Maximum results (default: 10)"),
});

const MemoryStoreSchema = z.object({
  content: z
    .string()
    .describe("The fact to remember — single, self-contained statement"),
  project: z.string().optional().describe("Project path to scope memory to"),
});

const MemoryUpdateSchema = z.object({
  id: z.string().describe("Memory ID to update (e.g. 'memory:abc123')"),
  content: z.string().describe("New content for this memory"),
});

const MemoryListSchema = z.object({
  limit: z.number().optional().describe("Maximum memories (default: 20)"),
  project: z.string().optional().describe("Filter to project-scoped memories"),
});

const MemoryDeleteSchema = z.object({
  id: z.string().describe("Memory ID to delete"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Neighbor with required id for relation creation */
interface NeighborRelation {
  id: string;
  distance: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Deduplicate array by key, preserving item types */
function dedupBy<T, K extends string | number>(
  key: (item: T) => K,
): (arr: T[]) => T[] {
  return (arr: T[]): T[] => {
    const seen = new Set<K>();
    return arr.filter((item) => {
      const k = key(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

const executeMemorySearch = async ({
  query,
  limit,
}: z.infer<typeof MemorySearchSchema>) => {
  const maxResults = limit ?? 10;
  const embedding = await embedOne(query);

  if (!embedding) return { results: [], message: "Failed to embed query" };

  const [vectorMatches, textMatches] = await Promise.all([
    searchByVector(embedding, 30),
    searchByText(query, 20),
  ]);

  const candidates = dedupBy((memory: Memory) => memory.id ?? "")([
    ...vectorMatches,
    ...textMatches,
  ]).filter(
    (memory): memory is Memory & { id: string } => memory.id !== undefined,
  );

  if (candidates.length === 0) {
    return { results: [], message: "No memories found" };
  }

  const ranked = await rerank(
    query,
    candidates.map((candidate) => candidate.content),
  );

  const results = ranked
    ? ranked
        .sort((left, right) => right.relevance_score - left.relevance_score)
        .slice(0, maxResults)
        .filter((rankedResult) => rankedResult.relevance_score > 0.1)
        .map((rankedResult) => candidates[rankedResult.index]?.content ?? "")
    : candidates.slice(0, maxResults).map((candidate) => candidate.content);

  log.info({ query, results: results.length }, "memory_search");
  return { results, message: null };
};

const executeMemoryStore = async ({
  content,
  project,
}: z.infer<typeof MemoryStoreSchema>) => {
  const embedding = await embedOne(content);

  if (!embedding) {
    return { stored: false, error: "Failed to generate embedding" };
  }

  const duplicate = await findDuplicate(embedding);
  if (duplicate) {
    return {
      stored: false,
      duplicate: duplicate.content,
      message: "Similar memory exists",
    };
  }

  const memoryId = await storeMemory({ content, project, embedding });
  if (!memoryId) {
    return { stored: false, error: "Failed to store memory" };
  }

  const neighbors = await findNeighbors(embedding, memoryId, 5, 0.3);
  const validNeighbors: NeighborRelation[] = neighbors.flatMap((neighbor) =>
    neighbor.id ? [{ id: neighbor.id, distance: neighbor.distance }] : [],
  );

  await Promise.all(
    validNeighbors.map((neighbor) =>
      createRelation(memoryId, neighbor.id, Math.max(0, 1 - neighbor.distance)),
    ),
  );

  log.info({ memoryId, neighbors: neighbors.length }, "memory_store");
  return {
    stored: true,
    id: memoryId,
    neighbors_linked: neighbors.length,
    error: null,
  };
};

const executeMemoryUpdate = async ({
  id,
  content,
}: z.infer<typeof MemoryUpdateSchema>) => {
  const embedding = await embedOne(content);

  if (!embedding) {
    return { updated: false, error: "Failed to generate embedding" };
  }

  const updated = await updateMemory(id, content, embedding);
  if (!updated) {
    return { updated: false, error: `Memory not found: ${id}` };
  }

  const neighbors = await findNeighbors(embedding, id, 5, 0.3);
  const validNeighbors: NeighborRelation[] = neighbors.flatMap((neighbor) =>
    neighbor.id ? [{ id: neighbor.id, distance: neighbor.distance }] : [],
  );

  await Promise.all(
    validNeighbors.map((neighbor) =>
      createRelation(id, neighbor.id, Math.max(0, 1 - neighbor.distance)),
    ),
  );

  log.info({ id, neighbors: neighbors.length }, "memory_update");
  return { updated: true, id, neighbors_linked: neighbors.length, error: null };
};

const executeMemoryList = async ({
  limit,
  project,
}: z.infer<typeof MemoryListSchema>) => {
  const memories = await listMemories(limit ?? 20);

  log.info(
    { count: memories.length, project: project ?? "all" },
    "memory_list",
  );

  return {
    memories: memories.map((memory) => ({
      id: memory.id,
      content: memory.content,
      project: memory.project ?? null,
      created_at: memory.created_at ?? null,
      access_count: memory.access_count ?? 0,
    })),
    error: null,
  };
};

const executeMemoryDelete = async ({
  id,
}: z.infer<typeof MemoryDeleteSchema>) => {
  const deleted = await deleteMemory(id);
  log.info({ id, deleted }, "memory_delete");
  return { deleted, id, error: deleted ? null : `Memory not found: ${id}` };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const memoryTools = {
  memory_search: tool({
    description:
      "Search persistent memory for facts, preferences, or context from past conversations.",
    inputSchema: MemorySearchSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemorySearch,
  }),

  memory_store: tool({
    description:
      "Store a fact in persistent memory. Use when user asks to remember something.",
    inputSchema: MemoryStoreSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryStore,
  }),

  memory_update: tool({
    description:
      "Update a memory's content by ID. Re-embeds and re-links neighbors.",
    inputSchema: MemoryUpdateSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryUpdate,
  }),

  memory_list: tool({
    description:
      "List stored memories, most recent first. Use to review or find IDs for deletion.",
    inputSchema: MemoryListSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryList,
  }),

  memory_delete: tool({
    description:
      "Delete a memory by ID. Confirm content with user before deleting.",
    inputSchema: MemoryDeleteSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryDelete,
  }),
};
