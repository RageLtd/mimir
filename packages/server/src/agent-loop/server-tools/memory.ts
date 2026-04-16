import { tool } from "ai";
import { z } from "zod";
import { embedOne } from "../../goldfish/clients";
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

export const MemorySearchSchema = z.object({
  query: z
    .string()
    .describe("Search query — keywords or natural language question"),
  limit: z.number().optional().describe("Maximum results (default: 10)"),
});

export const MemoryStoreSchema = z.object({
  content: z
    .string()
    .describe("The fact to remember — single, self-contained statement"),
  project: z.string().optional().describe("Project path to scope memory to"),
});

const MemoryUpdateSchema = z.object({
  id: z.string().describe("Memory ID to update (e.g. 'memory:abc123')"),
  content: z.string().describe("New content for this memory"),
});

export const MemoryListSchema = z.object({
  limit: z.number().optional().describe("Maximum memories (default: 20)"),
  project: z.string().optional().describe("Filter to project-scoped memories"),
});

export const MemoryDeleteSchema = z.object({
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

export const executeMemorySearch = async ({
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

  // Vector matches come first (ordered by distance), text matches appended after dedup.
  // Slice to maxResults — no reranker needed.
  const results = candidates
    .slice(0, maxResults)
    .map((candidate) => candidate.content);

  log.info({ query, results: results.length }, "project_memory_search");
  return { results, message: null };
};

export const executeMemoryStore = async ({
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

  log.info({ memoryId, neighbors: neighbors.length }, "project_memory_store");
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

  log.info({ id, neighbors: neighbors.length }, "project_memory_update");
  return { updated: true, id, neighbors_linked: neighbors.length, error: null };
};

export const executeMemoryList = async ({
  limit,
  project,
}: z.infer<typeof MemoryListSchema>) => {
  const memories = await listMemories(limit ?? 20);

  log.info(
    { count: memories.length, project: project ?? "all" },
    "project_memory_list",
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

export const executeMemoryDelete = async ({
  id,
}: z.infer<typeof MemoryDeleteSchema>) => {
  const deleted = await deleteMemory(id);
  log.info({ id, deleted }, "project_memory_delete");
  return { deleted, id, error: deleted ? null : `Memory not found: ${id}` };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const memoryTools = {
  project_memory_search: tool({
    description:
      "Search memories scoped to the current project — past architectural decisions, naming conventions, session summaries, pending work, and the reasoning behind choices already made in THIS codebase. Use when starting a task and needing cross-session context about the project, when the developer references a past decision, when a pattern looks deliberate and you want to know why, or when encountering unfamiliar code that may have recorded context. This is project-scoped knowledge, not facts about the developer themselves — use user_memory_search for that.",
    inputSchema: MemorySearchSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemorySearch,
  }),

  project_memory_store: tool({
    description:
      "Persist a project-scoped fact to cross-session memory. Use when an architectural decision is made, a non-obvious convention is established, a session reaches a good stopping point and its outcome should survive, or a piece of reasoning about THIS codebase would be valuable to future sessions. Scope is the current project — facts about the developer themselves (preferences, identity, setup) belong in user_memory_store instead.",
    inputSchema: MemoryStoreSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryStore,
  }),

  project_memory_update: tool({
    description:
      "Update the content of an existing project memory by ID. Re-embeds and re-links neighbors. Use when a stored project memory is now wrong or superseded — prefer updating over storing a duplicate. Find the target ID via project_memory_search or project_memory_list.",
    inputSchema: MemoryUpdateSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryUpdate,
  }),

  project_memory_list: tool({
    description:
      "List project memories in recency order. Use to review what's been persisted for this project, find the ID of a specific memory for update or deletion, or audit the current knowledge base when context is scarce.",
    inputSchema: MemoryListSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryList,
  }),

  project_memory_delete: tool({
    description:
      "Delete a project memory by ID. Confirm the content with the developer before calling — memories are the persistent project record and removal should be deliberate.",
    inputSchema: MemoryDeleteSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeMemoryDelete,
  }),
};
