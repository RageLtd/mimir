import { RecordId } from "surrealdb";
import { type OrgScope, scopedQueryFirst, scopedQueryOne } from "../db/scope";
import { log } from "../util/logger";

/**
 * Cosine DISTANCE projection for the brute-force KNN queries below. SurrealDB
 * ships `vector::similarity::cosine` (higher = closer), not a
 * `vector::distance::cosine` — so distance is `1 - similarity` (0 = identical,
 * ascending = nearest first). Every consumer here treats the alias as a
 * distance: `ORDER BY distance`, the dedup `<= threshold`, the neighbour
 * `<= maxDistance`. Bind $embedding on the query.
 */
const COSINE_DISTANCE_SELECT =
  "(1 - vector::similarity::cosine(embedding, $embedding)) AS distance";

/** Convert a string ID like "memory:abc123" to a SurrealDB RecordId.
 *  Passes through RecordId objects unchanged — safe on query results. */
export function toRecordId(id: string | RecordId) {
  if (id instanceof RecordId) return id;
  const colonIdx = id.indexOf(":");
  return new RecordId(id.slice(0, colonIdx), id.slice(colonIdx + 1));
}

export interface Memory {
  id?: string;
  content: string;
  /** Canonical project ULID. Unset on global memories (e.g. summaries). */
  project_id?: string;
  type?: "fact" | "summary" | "playbook" | "skill";
  /** Playbook only — short label shown in the always-injected index. */
  name?: string;
  /** Playbook only — the "use this when…" line. Doubles as the embedding
   *  key (see storeTypedMemory) so ambient matching keys on intent. */
  trigger?: string;
  message_count?: number;
  last_message_id?: string;
  token_count?: number;
  created_at?: string;
  last_accessed?: string;
  confidence?: number;
  access_count?: number;
  embedding: number[];
}

/** Store a memory with its embedding, stamped with the org. */
export async function storeMemory(scope: OrgScope, memory: Memory) {
  const fields: Omit<
    Memory,
    "id" | "created_at" | "last_accessed" | "confidence" | "access_count"
  > & { org_id: string } = {
    content: memory.content,
    embedding: memory.embedding,
    type: memory.type ?? "fact",
    org_id: scope.orgId,
  };
  if (memory.project_id) fields.project_id = memory.project_id;
  if (memory.name) fields.name = memory.name;
  if (memory.trigger) fields.trigger = memory.trigger;
  if (memory.message_count !== undefined) {
    fields.message_count = memory.message_count;
  }
  if (memory.last_message_id) fields.last_message_id = memory.last_message_id;
  if (memory.token_count !== undefined) fields.token_count = memory.token_count;

  const created = await scopedQueryFirst<Memory>(
    scope,
    `CREATE memory CONTENT $fields`,
    { fields },
  );
  if (created?.id) {
    log.info(
      {
        id: created.id,
        content: memory.content.slice(0, 100),
        type: fields.type,
        project_id: memory.project_id,
        org_id: scope.orgId,
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

/**
 * Vector search scoped to the org. Exact cosine KNN (MIM-69): a `WHERE org_id`
 * filter + brute-force cosine-distance ordering (see COSINE_DISTANCE_SELECT).
 * Per-org memory
 * counts are in the thousands, so exact is fast and — unlike the dropped
 * global HNSW index — never starves a tenant by post-filtering another's
 * nearest vectors (surrealdb#7372).
 */
export async function searchByVector(
  scope: OrgScope,
  embedding: number[],
  limit = 30,
) {
  const start = Date.now();
  const found = await scopedQueryOne<Memory>(
    scope,
    `SELECT *, ${COSINE_DISTANCE_SELECT}
     FROM memory
     WHERE org_id = $scope_org
     ORDER BY distance
     LIMIT $limit`,
    { embedding, scope_org: scope.orgId, limit },
  );
  log.debug(
    { results: found.length, limit, elapsed: `${Date.now() - start}ms` },
    "vector search",
  );
  return found;
}

/** Full-text search for memories, scoped to the org. */
export async function searchByText(scope: OrgScope, query: string, limit = 20) {
  const start = Date.now();
  const found = await scopedQueryOne<Memory>(
    scope,
    `SELECT *, search::score(1) AS score
     FROM memory
     WHERE content @1@ $query AND org_id = $scope_org
     ORDER BY score DESC
     LIMIT $limit`,
    { query, limit, scope_org: scope.orgId },
  );
  log.debug(
    { query, results: found.length, limit, elapsed: `${Date.now() - start}ms` },
    "text search",
  );
  return found;
}

/** Check if a very similar memory already exists (dedup), scoped to the org. */
export async function findDuplicate(
  scope: OrgScope,
  embedding: number[],
  threshold = 0.05,
) {
  const top = await scopedQueryFirst<Memory & { distance: number }>(
    scope,
    `SELECT *, ${COSINE_DISTANCE_SELECT}
     FROM memory
     WHERE org_id = $scope_org
     ORDER BY distance
     LIMIT 1`,
    { embedding, scope_org: scope.orgId },
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

/** N nearest neighbors within the org, excluding a specific memory ID. */
export async function findNeighbors(
  scope: OrgScope,
  embedding: number[],
  excludeId: string,
  limit = 5,
  maxDistance = 0.3,
) {
  const results = await scopedQueryOne<Memory & { distance: number }>(
    scope,
    `SELECT *, ${COSINE_DISTANCE_SELECT}
     FROM memory
     WHERE org_id = $scope_org
     ORDER BY distance
     LIMIT $limit`,
    { embedding, scope_org: scope.orgId, limit: limit + 1 },
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

/** Create a relates_to edge between two memories, stamped with the org. */
export async function createRelation(
  scope: OrgScope,
  fromId: string,
  toId: string,
  weight: number,
  relationType = "relates_to",
) {
  await scope.db.query(
    `RELATE $from -> relates_to -> $to
     SET weight = $weight, relation_type = $type, org_id = $scope_org`,
    {
      from: toRecordId(fromId),
      to: toRecordId(toId),
      weight,
      type: relationType,
      scope_org: scope.orgId,
    },
  );
  log.debug(
    { from: fromId, to: toId, weight, type: relationType },
    "created relation",
  );
}

/** Memories related to a set of IDs, one graph hop, scoped to the org. */
export async function getRelatedMemories(
  scope: OrgScope,
  memoryIds: string[],
  limit = 10,
) {
  if (memoryIds.length === 0) return [];
  const start = Date.now();

  const outgoing = await scopedQueryOne<{
    id: string;
    content: string;
    project_id?: string;
    weight: number;
  }>(
    scope,
    `SELECT out.id AS id, out.content AS content, out.project_id AS project_id, weight
     FROM relates_to
     WHERE in IN $ids AND org_id = $scope_org
     ORDER BY weight DESC
     LIMIT $limit`,
    { ids: memoryIds, limit, scope_org: scope.orgId },
  );

  const incoming = await scopedQueryOne<{
    id: string;
    content: string;
    project_id?: string;
    weight: number;
  }>(
    scope,
    `SELECT in.id AS id, in.content AS content, in.project_id AS project_id, weight
     FROM relates_to
     WHERE out IN $ids AND org_id = $scope_org
     ORDER BY weight DESC
     LIMIT $limit`,
    { ids: memoryIds, limit, scope_org: scope.orgId },
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
      project_id: m.project_id,
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

/** Touch memories: bump last_accessed + access_count. Org-constrained so a
 *  stray foreign id is a no-op. */
export async function touchMemories(scope: OrgScope, memoryIds: string[]) {
  if (memoryIds.length === 0) return;
  await scope.db.query(
    `UPDATE $ids SET
      last_accessed = time::now(),
      access_count = access_count + 1
     WHERE org_id = $scope_org`,
    { ids: memoryIds, scope_org: scope.orgId },
  );
  log.debug({ count: memoryIds.length, ids: memoryIds }, "touched memories");
}

/** List recent memories within the org. */
export async function listMemories(scope: OrgScope, limit = 20) {
  return scopedQueryOne<{
    id: string;
    content: string;
    project_id?: string;
    created_at?: string;
    confidence?: number;
    access_count?: number;
  }>(
    scope,
    `SELECT id, content, project_id, created_at, confidence, access_count
     FROM memory
     WHERE org_id = $scope_org
     ORDER BY created_at DESC
     LIMIT $limit`,
    { limit, scope_org: scope.orgId },
  );
}

/** Last N summaries within the org (for context assembly). */
export async function getLastSummaries(scope: OrgScope, count: number = 3) {
  const start = Date.now();
  const results = await scopedQueryOne<{
    content: string;
    token_count?: number;
    created_at: string;
  }>(
    scope,
    `SELECT content, token_count, created_at
     FROM memory
     WHERE type = 'summary' AND org_id = $scope_org
     ORDER BY created_at DESC
     LIMIT $count`,
    { count, scope_org: scope.orgId },
  );
  log.debug(
    { count: results.length, elapsed: `${Date.now() - start}ms` },
    "retrieved summaries",
  );
  return results;
}

/** Update a memory's content, re-embed, and re-link neighbors, within the org. */
export async function updateMemory(
  scope: OrgScope,
  id: string,
  content: string,
  embedding: number[],
) {
  const rid = toRecordId(id);
  const existing = await scopedQueryFirst<{ id: string }>(
    scope,
    `SELECT id FROM $id WHERE org_id = $scope_org`,
    { id: rid, scope_org: scope.orgId },
  );
  if (!existing) return false;

  await scope.db.query(
    `UPDATE $id SET
      content = $content,
      embedding = $embedding,
      last_accessed = time::now(),
      confidence = 1.0
     WHERE org_id = $scope_org`,
    { id: rid, content, embedding, scope_org: scope.orgId },
  );
  await scope.db.query(
    `DELETE relates_to WHERE (in = $id OR out = $id) AND org_id = $scope_org`,
    { id: rid, scope_org: scope.orgId },
  );
  log.info({ id, content }, "updated memory");
  return true;
}

/** Delete a memory by ID within the org. */
export async function deleteMemory(scope: OrgScope, id: string) {
  const rid = toRecordId(id);
  await scope.db.query(
    `DELETE relates_to WHERE (in = $id OR out = $id) AND org_id = $scope_org`,
    { id: rid, scope_org: scope.orgId },
  );
  const result = await scopedQueryOne<{ id: string }>(
    scope,
    `DELETE $id WHERE org_id = $scope_org RETURN BEFORE`,
    { id: rid, scope_org: scope.orgId },
  );
  const deleted = result.length > 0;
  if (deleted) log.info({ id }, "deleted memory");
  else log.warn({ id }, "memory not found for deletion");
  return deleted;
}

/** Freshness factor for a memory based on time since last access. */
export function computeFreshness(lastAccessed?: string) {
  if (!lastAccessed) return 1.0;
  const now = Date.now();
  const accessed = new Date(lastAccessed).getTime();
  const daysSinceAccess = (now - accessed) / (1000 * 60 * 60 * 24);
  const halfLifeDays = 30;
  const decay = Math.exp((-daysSinceAccess * Math.LN2) / halfLifeDays);
  return Math.max(0.1, decay);
}
