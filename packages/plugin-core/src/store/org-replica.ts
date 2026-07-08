/**
 * Org-memory replica — the local brain's store (MIM-84).
 *
 * Local-first mirror of the server's goldfish memory store: same record
 * shape (server-style `memory:<id>` string ids, fact/summary/playbook/skill
 * types, confidence/access decay fields, relates_to edges) so the retrieval
 * brain ports 1:1 and the import script can upsert server rows verbatim.
 *
 * Backed by bun:sqlite like the user-memory store (the in-repo precedent).
 * FTS5 external-content table + trigger trio for BM25 text search; vector
 * search is exact cosine computed in-process — per-org N is thousands, so
 * brute force is milliseconds and there is no index to corrupt or starve.
 *
 * Embeddings are nullable: rows imported from the server arrive WITHOUT
 * vectors (the server's are Cohere-space; cross-space similarity is noise —
 * proven by the reembed-import work). The local embedder (MIM-85) fills
 * them in; until then retrieval degrades to FTS + recency + confidence.
 *
 * Plaintext by design — see THREAT_MODEL.md §4: crypto lives only at the
 * sync seam (MIM-88), never in the brain.
 */

import { Database } from "bun:sqlite";
import {
  blobToEmbedding,
  cosineDistance,
  embeddingToBlob,
  escapeFtsQuery,
  generateMemoryId,
  SCHEMA,
} from "./org-replica-support";

// Re-exported so consumers keep a single import site for the replica API.
export {
  computeFreshness,
  cosineDistance,
  defaultOrgReplicaPath,
  generateMemoryId,
} from "./org-replica-support";

export type MemoryType = "fact" | "summary" | "playbook" | "skill";

export type ReplicaMemory = {
  readonly id: string;
  readonly org_id: string;
  readonly content: string;
  readonly project_id: string | null;
  readonly type: MemoryType;
  readonly name: string | null;
  readonly trigger: string | null;
  readonly message_count: number | null;
  readonly last_message_id: string | null;
  readonly token_count: number | null;
  readonly confidence: number;
  readonly access_count: number;
  readonly created_at: string;
  readonly last_accessed: string | null;
  readonly updated_at: string;
};

type MemoryRow = ReplicaMemory & { readonly embedding: Uint8Array | null };

export type NewMemory = {
  readonly content: string;
  readonly project_id?: string;
  readonly type?: MemoryType;
  readonly name?: string;
  readonly trigger?: string;
  readonly message_count?: number;
  readonly last_message_id?: string;
  readonly token_count?: number;
  readonly embedding?: number[] | null;
};

/** Upsert input — import path. Preserves server ids and timestamps. */
export type UpsertMemory = NewMemory & {
  readonly id: string;
  readonly org_id?: string;
  readonly confidence?: number;
  readonly access_count?: number;
  readonly created_at?: string;
  readonly last_accessed?: string;
};

const stripEmbedding = ({ embedding: _drop, ...rest }: MemoryRow) => rest;

export const createOrgReplica = (dbPath: string) => {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  db.run(SCHEMA);

  const insertMemory = (id: string, memory: UpsertMemory, upsert: boolean) => {
    const conflict = upsert
      ? `ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          project_id = excluded.project_id,
          type = excluded.type,
          name = excluded.name,
          trigger = excluded.trigger,
          message_count = excluded.message_count,
          last_message_id = excluded.last_message_id,
          token_count = excluded.token_count,
          confidence = excluded.confidence,
          access_count = excluded.access_count,
          last_accessed = excluded.last_accessed,
          embedding = excluded.embedding,
          updated_at = datetime('now')`
      : "";
    db.query(
      `INSERT INTO memory (
        id, org_id, content, project_id, type, name, trigger,
        message_count, last_message_id, token_count, confidence,
        access_count, created_at, last_accessed, embedding
      ) VALUES (
        $id, $org_id, $content, $project_id, $type, $name, $trigger,
        $message_count, $last_message_id, $token_count, $confidence,
        $access_count, COALESCE($created_at, datetime('now')), $last_accessed, $embedding
      ) ${conflict}`,
    ).run({
      $id: id,
      $org_id: memory.org_id ?? "",
      $content: memory.content,
      $project_id: memory.project_id ?? null,
      $type: memory.type ?? "fact",
      $name: memory.name ?? null,
      $trigger: memory.trigger ?? null,
      $message_count: memory.message_count ?? null,
      $last_message_id: memory.last_message_id ?? null,
      $token_count: memory.token_count ?? null,
      $confidence: memory.confidence ?? 1.0,
      $access_count: memory.access_count ?? 0,
      $created_at: memory.created_at ?? null,
      $last_accessed: memory.last_accessed ?? null,
      $embedding: memory.embedding ? embeddingToBlob(memory.embedding) : null,
    });
    return id;
  };

  /** Store a new memory; generates a server-style id. */
  const storeMemory = (memory: NewMemory) =>
    insertMemory(generateMemoryId(), { ...memory, id: "" }, false);

  /** Import path — preserves the given id/timestamps, idempotent. */
  const upsertMemory = (memory: UpsertMemory) =>
    insertMemory(memory.id, memory, true);

  const getMemory = (id: string) => {
    const row = db
      .query<MemoryRow, [string]>("SELECT * FROM memory WHERE id = ?")
      .get(id);
    return row ? stripEmbedding(row) : null;
  };

  /** Exact cosine KNN over all embedded rows, nearest first. Rows without
   *  embeddings are invisible here (FTS covers them). */
  const searchByVector = (embedding: number[], limit = 30) => {
    const query = Float32Array.from(embedding);
    const rows = db
      .query<MemoryRow, []>("SELECT * FROM memory WHERE embedding IS NOT NULL")
      .all();
    return rows
      .map((row) => ({
        ...stripEmbedding(row),
        distance: row.embedding
          ? cosineDistance(query, blobToEmbedding(row.embedding))
          : 1,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  };

  /** BM25 text search. `score` is positive, higher = better (negated FTS5
   *  rank), same orientation as the server's search::score. */
  const searchByText = (query: string, limit = 20) => {
    const rows = db
      .query<MemoryRow & { rank: number }, [string, number]>(
        `SELECT m.*, f.rank AS rank
         FROM memory m JOIN memory_fts f ON m.rowid = f.rowid
         WHERE memory_fts MATCH ?
         ORDER BY f.rank
         LIMIT ?`,
      )
      .all(escapeFtsQuery(query), limit);
    return rows.map((row) => ({
      ...stripEmbedding(row),
      score: -row.rank,
    }));
  };

  const findDuplicate = (embedding: number[], threshold = 0.05) => {
    const [top] = searchByVector(embedding, 1);
    return top && top.distance <= threshold ? top : null;
  };

  const findNeighbors = (
    embedding: number[],
    excludeId: string,
    limit = 5,
    maxDistance = 0.3,
  ) =>
    searchByVector(embedding, limit + 1)
      .filter((r) => r.id !== excludeId && r.distance <= maxDistance)
      .slice(0, limit);

  const createRelation = (
    fromId: string,
    toId: string,
    weight: number,
    relationType = "relates_to",
  ) => {
    db.query(
      `INSERT INTO relates_to (from_id, to_id, weight, relation_type)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(from_id, to_id) DO UPDATE SET
         weight = excluded.weight, relation_type = excluded.relation_type`,
    ).run(fromId, toId, weight, relationType);
  };

  /** One graph hop from a seed set, both directions, weight-ranked,
   *  seed ids excluded — mirrors goldfish getRelatedMemories. */
  const getRelatedMemories = (memoryIds: string[], limit = 10) => {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = db
      .query<
        {
          id: string;
          content: string;
          project_id: string | null;
          weight: number;
        },
        string[]
      >(
        `SELECT m.id AS id, m.content AS content, m.project_id AS project_id, r.weight AS weight
         FROM relates_to r JOIN memory m ON m.id = r.to_id
         WHERE r.from_id IN (${placeholders})
         UNION ALL
         SELECT m.id, m.content, m.project_id, r.weight
         FROM relates_to r JOIN memory m ON m.id = r.from_id
         WHERE r.to_id IN (${placeholders})`,
      )
      .all(...memoryIds, ...memoryIds);
    const seen = new Set<string>();
    const seedSet = new Set(memoryIds);
    return rows
      .filter((m) => {
        if (seen.has(m.id) || seedSet.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  };

  const touchMemories = (memoryIds: string[]) => {
    if (memoryIds.length === 0) return;
    const placeholders = memoryIds.map(() => "?").join(",");
    db.query(
      `UPDATE memory SET
        last_accessed = datetime('now'),
        access_count = access_count + 1
       WHERE id IN (${placeholders})`,
    ).run(...memoryIds);
  };

  const listMemories = (limit = 20) =>
    db
      .query<MemoryRow, [number]>(
        "SELECT * FROM memory ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(stripEmbedding);

  const getLastSummaries = (count = 3) =>
    db
      .query<
        { content: string; token_count: number | null; created_at: string },
        [number]
      >(
        `SELECT content, token_count, created_at
         FROM memory WHERE type = 'summary'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(count);

  const listPlaybooks = () =>
    db
      .query<MemoryRow, []>(
        "SELECT * FROM memory WHERE type = 'playbook' AND name IS NOT NULL ORDER BY created_at ASC",
      )
      .all()
      .map(stripEmbedding);

  /** Update content (+ optional re-embed); severs relations like the
   *  server does — stale edges are worse than missing ones. */
  const updateMemory = (
    id: string,
    content: string,
    embedding?: number[] | null,
  ) => {
    const result = db
      .query(
        `UPDATE memory SET
          content = $content,
          embedding = COALESCE($embedding, embedding),
          last_accessed = datetime('now'),
          confidence = 1.0,
          updated_at = datetime('now')
         WHERE id = $id`,
      )
      .run({
        $id: id,
        $content: content,
        $embedding: embedding ? embeddingToBlob(embedding) : null,
      });
    if (result.changes === 0) return false;
    db.query("DELETE FROM relates_to WHERE from_id = ? OR to_id = ?").run(
      id,
      id,
    );
    return true;
  };

  const deleteMemory = (id: string) => {
    db.query("DELETE FROM relates_to WHERE from_id = ? OR to_id = ?").run(
      id,
      id,
    );
    const result = db.query("DELETE FROM memory WHERE id = ?").run(id);
    return result.changes > 0;
  };

  /** Rows lacking a vector — MIM-85's local embedder backfills these. */
  const listUnembedded = (limit = 500) =>
    db
      .query<
        {
          id: string;
          content: string;
          type: MemoryType;
          name: string | null;
          trigger: string | null;
        },
        [number]
      >(
        `SELECT id, content, type, name, trigger
         FROM memory WHERE embedding IS NULL LIMIT ?`,
      )
      .all(limit);

  const setEmbedding = (id: string, embedding: number[]) => {
    const result = db
      .query("UPDATE memory SET embedding = ? WHERE id = ?")
      .run(embeddingToBlob(embedding), id);
    return result.changes > 0;
  };

  const countMemories = () => {
    const row = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory")
      .get();
    return row?.n ?? 0;
  };

  const close = () => {
    db.close();
  };

  return {
    storeMemory,
    upsertMemory,
    getMemory,
    searchByVector,
    searchByText,
    findDuplicate,
    findNeighbors,
    createRelation,
    getRelatedMemories,
    touchMemories,
    listMemories,
    getLastSummaries,
    listPlaybooks,
    updateMemory,
    deleteMemory,
    listUnembedded,
    setEmbedding,
    countMemories,
    close,
  };
};

export type OrgReplica = ReturnType<typeof createOrgReplica>;
