import { RecordId } from "surrealdb";
import { getDb, queryFirst, queryOne } from "../db/surreal";
import { log } from "../util/logger";

/** Parse a "table:id" string into a SurrealDB RecordId for parameterized queries. */
function toRecordId(id: string) {
  const [table, key] = id.split(":") as [string, string];
  return new RecordId(table, key);
}

export interface Memory {
  id?: string;
  content: string;
  project?: string;
  type?: "fact" | "summary";
  message_count?: number;
  last_message_id?: string;
  token_count?: number;
  created_at?: string;
  last_accessed?: string;
  confidence?: number;
  access_count?: number;
  embedding: number[];
}

/** Store a memory with its embedding. Confidence starts at 1.0. */
export async function storeMemory(memory: Memory): Promise<string | null> {
  const fields: Omit<
    Memory,
    "id" | "created_at" | "last_accessed" | "confidence" | "access_count"
  > = {
    content: memory.content,
    embedding: memory.embedding,
    type: memory.type ?? "fact",
  };
  if (memory.project) {
    fields.project = memory.project;
  }
  if (memory.message_count !== undefined) {
    fields.message_count = memory.message_count;
  }
  if (memory.last_message_id) {
    fields.last_message_id = memory.last_message_id;
  }
  if (memory.token_count !== undefined) {
    fields.token_count = memory.token_count;
  }

  const created = await queryFirst<Memory>(
    /* surql */ `
    CREATE memory CONTENT $fields
    `,
    { fields },
  );
  if (created?.id) {
    log.info(
      {
        id: created.id,
        content: memory.content.slice(0, 100),
        type: fields.type,
        project: memory.project,
      },
      "stored memory",
    );
  } else {
    log.error(
      { content: memory.content.slice(0, 100) },
      "failed to store memory — no ID returned",
    );
  }
  return created?.id ?? null;
}

/** Vector search for similar memories using HNSW index (global search) */
export async function searchByVector(
  embedding: number[],
  limit = 30,
): Promise<Memory[]> {
  const start = Date.now();

  const found = await queryOne<Memory>(
    /* surql */ `
    SELECT *, vector::distance::knn() AS distance
    FROM memory
    WHERE embedding <|${limit},40|> $embedding
    ORDER BY distance
    `,
    { embedding },
  );

  log.debug(
    {
      results: found.length,
      limit,
      elapsed: `${Date.now() - start}ms`,
    },
    "vector search",
  );
  return found;
}

/** Full-text search for memories (global search) */
export async function searchByText(
  query: string,
  limit = 20,
): Promise<Memory[]> {
  const start = Date.now();

  const found = await queryOne<Memory>(
    /* surql */ `
    SELECT *, search::score(1) AS score
    FROM memory
    WHERE content @1@ $query
    ORDER BY score DESC
    LIMIT $limit
    `,
    { query, limit },
  );

  log.debug(
    {
      query,
      results: found.length,
      limit,
      elapsed: `${Date.now() - start}ms`,
    },
    "text search",
  );
  return found;
}

/** Check if a very similar memory already exists (dedup) */
export async function findDuplicate(
  embedding: number[],
  threshold = 0.05,
): Promise<Memory | null> {
  const top = await queryFirst<Memory & { distance: number }>(
    /* surql */ `
    SELECT *, vector::distance::knn() AS distance
    FROM memory
    WHERE embedding <|1,40|> $embedding
    `,
    { embedding },
  );

  if (top && top.distance <= threshold) {
    log.debug(
      { id: top.id, distance: top.distance, threshold, content: top.content },
      "duplicate found",
    );
    return top;
  }
  return null;
}

/**
 * Find the N nearest neighbors to an embedding, excluding a specific memory ID.
 */
export async function findNeighbors(
  embedding: number[],
  excludeId: string,
  limit = 5,
  maxDistance = 0.3,
): Promise<Array<Memory & { distance: number }>> {
  const results = await queryOne<Memory & { distance: number }>(
    /* surql */ `
    SELECT *, vector::distance::knn() AS distance
    FROM memory
    WHERE embedding <|${limit + 1},40|> $embedding
    ORDER BY distance
    LIMIT ${limit + 1}
    `,
    { embedding },
  );

  const filtered = results
    .filter((r) => r.id !== excludeId && r.distance <= maxDistance)
    .slice(0, limit);

  log.debug(
    {
      excludeId,
      candidates: results.length,
      matched: filtered.length,
      maxDistance,
    },
    "neighbor search",
  );
  return filtered;
}

/**
 * Create a relates_to edge between two memories.
 */
export async function createRelation(
  fromId: string,
  toId: string,
  weight: number,
  relationType = "relates_to",
): Promise<void> {
  const db = await getDb();

  await db.query(
    /* surql */ `
    RELATE $from -> relates_to -> $to
    SET weight = $weight, relation_type = $type
    `,
    {
      from: toRecordId(fromId),
      to: toRecordId(toId),
      weight,
      type: relationType,
    },
  );

  log.debug(
    { from: fromId, to: toId, weight, type: relationType },
    "created relation",
  );
}

/**
 * Get memories related to a set of memory IDs by walking the graph one hop.
 */
export async function getRelatedMemories(
  memoryIds: string[],
  limit = 10,
): Promise<Memory[]> {
  if (memoryIds.length === 0) return [];

  const start = Date.now();
  const rids = memoryIds.map(toRecordId);

  const outgoing = await queryOne<{
    id: string;
    content: string;
    project?: string;
    weight: number;
  }>(
    /* surql */ `
    SELECT out.id AS id, out.content AS content, out.project AS project, weight
    FROM relates_to
    WHERE in IN $ids
    ORDER BY weight DESC
    LIMIT $limit
    `,
    { ids: rids, limit },
  );

  const incoming = await queryOne<{
    id: string;
    content: string;
    project?: string;
    weight: number;
  }>(
    /* surql */ `
    SELECT in.id AS id, in.content AS content, in.project AS project, weight
    FROM relates_to
    WHERE out IN $ids
    ORDER BY weight DESC
    LIMIT $limit
    `,
    { ids: rids, limit },
  );

  const all = [...outgoing, ...incoming];
  const seen = new Set<string>();
  const idSet = new Set(memoryIds);

  const result = all
    .filter((m) => {
      if (!m.id || seen.has(m.id) || idSet.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((m) => ({
      id: m.id,
      content: m.content,
      project: m.project,
      embedding: [],
    }));

  log.debug(
    {
      seedIds: memoryIds.length,
      outgoing: outgoing.length,
      incoming: incoming.length,
      deduped: result.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "graph walk",
  );
  return result;
}

/**
 * Touch a set of memories: update last_accessed and increment access_count.
 */
export async function touchMemories(memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return;

  const db = await getDb();
  await db.query(
    /* surql */ `
    UPDATE $ids SET
      last_accessed = time::now(),
      access_count = access_count + 1
    `,
    { ids: memoryIds.map(toRecordId) },
  );

  log.debug({ count: memoryIds.length, ids: memoryIds }, "touched memories");
}

/** List recent memories (global, no project filter) */
export async function listMemories(limit = 20): Promise<
  Array<{
    id: string;
    content: string;
    project?: string;
    created_at?: string;
    confidence?: number;
    access_count?: number;
  }>
> {
  return queryOne<{
    id: string;
    content: string;
    project?: string;
    created_at?: string;
    confidence?: number;
    access_count?: number;
  }>(
    `SELECT id, content, project, created_at, confidence, access_count
     FROM memory
     ORDER BY created_at DESC
     LIMIT $limit`,
    { limit },
  );
}

/** Get last N summaries (global, for context assembly) */
export async function getLastSummaries(
  count: number = 3,
): Promise<
  Array<{ content: string; token_count?: number; created_at: string }>
> {
  const start = Date.now();

  const results = await queryOne<{
    content: string;
    token_count?: number;
    created_at: string;
  }>(
    /* surql */ `
    SELECT content, token_count, created_at
    FROM memory
    WHERE type = 'summary'
    ORDER BY created_at DESC
    LIMIT $count
    `,
    { count },
  );

  log.debug(
    {
      count: results.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "retrieved summaries",
  );

  return results;
}

/** Update a memory's content, re-embed, and re-link neighbors */
export async function updateMemory(
  id: string,
  content: string,
  embedding: number[],
): Promise<boolean> {
  const db = await getDb();
  const rid = toRecordId(id);

  // Check existence
  const existing = await queryFirst<{ id: string }>(`SELECT id FROM $id`, {
    id: rid,
  });
  if (!existing) return false;

  // Update content + embedding, reset access tracking
  await db.query(
    `UPDATE $id SET
      content = $content,
      embedding = $embedding,
      last_accessed = time::now(),
      confidence = 1.0`,
    { id: rid, content, embedding },
  );

  // Remove old relations
  await db.query(`DELETE relates_to WHERE in = $id OR out = $id`, { id: rid });

  log.info({ id, content }, "updated memory");
  return true;
}

/** Delete a memory by ID */
export async function deleteMemory(id: string): Promise<boolean> {
  const db = await getDb();
  const rid = toRecordId(id);
  // Delete relations first
  await db.query(`DELETE relates_to WHERE in = $id OR out = $id`, { id: rid });
  const result = await queryOne<{ id: string }>(`DELETE $id RETURN BEFORE`, {
    id: rid,
  });
  const deleted = result.length > 0;
  if (deleted) {
    log.info({ id }, "deleted memory");
  } else {
    log.warn({ id }, "memory not found for deletion");
  }
  return deleted;
}

/**
 * Compute a freshness factor for a memory based on time since last access.
 */
export function computeFreshness(lastAccessed?: string) {
  if (!lastAccessed) return 1.0;

  const now = Date.now();
  const accessed = new Date(lastAccessed).getTime();
  const daysSinceAccess = (now - accessed) / (1000 * 60 * 60 * 24);

  const halfLifeDays = 30;
  const decay = Math.exp((-daysSinceAccess * Math.LN2) / halfLifeDays);
  return Math.max(0.1, decay);
}
