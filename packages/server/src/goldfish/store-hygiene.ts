/**
 * Store helpers used only by the memory hygiene sweep.
 *
 * Kept separate from store.ts so the hot-path store stays under the 500-line
 * cap and the hygiene-only queries (full scans, batch decay, canonical merge)
 * are easy to find and reason about in isolation.
 */

import { queryFirst, queryOne } from "../db/surreal";
import { log } from "../util/logger";
import { type Memory, toRecordId } from "./store";

/**
 * Stream every memory in pages. The sweep needs the whole set (embeddings
 * included, for neighbour clustering), but loading it in one query risks a
 * huge response — page through in fixed chunks instead.
 */
export async function listAllMemories(pageSize = 500): Promise<Memory[]> {
  const all: Memory[] = [];
  let start = 0;

  for (;;) {
    const page = await queryOne<Memory>(
      /* surql */ `
      SELECT id, content, project, type, confidence, access_count,
             last_accessed, created_at, embedding
      FROM memory
      ORDER BY created_at
      LIMIT ${pageSize} START ${start}
      `,
    );
    all.push(...page);
    if (page.length < pageSize) break;
    start += pageSize;
  }

  log.debug({ total: all.length, pageSize }, "listed all memories for hygiene");
  return all;
}

export interface CanonicalInput {
  readonly content: string;
  readonly embedding: number[];
  readonly project?: string;
  /** Summed access counts of the merged members — preserves earned signal. */
  readonly accessCount: number;
  /** Highest confidence among the merged members. */
  readonly confidence: number;
}

/**
 * Create the single canonical memory that replaces a merged cluster. Carries
 * forward the aggregated access count and confidence so the merge doesn't
 * reset the cluster's earned standing. created_at/last_accessed default to
 * time::now() via the schema (see db/surreal.ts), so the merge counts as a
 * fresh access — SurrealQL forbids combining CONTENT with a trailing SET.
 */
export async function createCanonicalMemory(input: CanonicalInput) {
  const fields: Record<string, unknown> = {
    content: input.content,
    embedding: input.embedding,
    type: "fact",
    access_count: input.accessCount,
    confidence: input.confidence,
  };
  if (input.project) fields.project = input.project;

  const created = await queryFirst<Memory>(
    /* surql */ `
    CREATE memory CONTENT $fields
    `,
    { fields },
  );

  if (!created?.id) {
    log.error(
      { content: input.content.slice(0, 80) },
      "canonical create failed",
    );
    return null;
  }
  return created.id;
}

/**
 * Decay confidence on every fact not accessed within the last `olderThanSeconds`.
 * Gives confidence a real time signal — without this it sits frozen at 1.0
 * forever. Returns the number of memories decayed.
 */
export async function decayUntouchedConfidence(
  factor: number,
  olderThanSeconds: number,
): Promise<number> {
  const seconds = Math.max(0, Math.round(olderThanSeconds));
  const decayed = await queryOne<{ id: string }>(
    /* surql */ `
    UPDATE memory SET confidence = confidence * $factor
    WHERE type = 'fact' AND last_accessed < time::now() - ${seconds}s
    RETURN id
    `,
    { factor },
  );
  log.info({ count: decayed.length, factor }, "decayed untouched confidence");
  return decayed.length;
}

/** Count of memories currently stored — for sweep reporting. */
export async function countMemories() {
  const row = await queryFirst<{ count: number }>(
    `SELECT count() AS count FROM memory GROUP ALL`,
  );
  return row?.count ?? 0;
}

/**
 * Multiply one memory's confidence by `factor` (in (0,1]). The contradiction
 * pass uses this to demote a superseded fact WITHOUT deleting it — the lowered
 * confidence both sinks it in retrieval ranking and feeds the prune pass, so a
 * superseded fact fades over subsequent sweeps rather than vanishing now.
 * Returns the post-demotion confidence, or null if the memory was not found.
 */
export async function demoteConfidence(id: string, factor: number) {
  const updated = await queryFirst<{ confidence: number }>(
    /* surql */ `
    UPDATE $id SET confidence = confidence * $factor RETURN AFTER
    `,
    { id: toRecordId(id), factor },
  );
  if (!updated) {
    log.warn({ id }, "demoteConfidence — memory not found");
    return null;
  }
  log.info(
    { id, factor, confidence: updated.confidence },
    "demoted memory confidence",
  );
  return updated.confidence;
}

/**
 * Every supersedes edge currently in the graph, as {from, to} string-id pairs.
 * The contradiction pass consults these to skip pairs it has already ruled on,
 * so a confirmed contradiction is demoted exactly once instead of every sweep.
 */
export async function listSupersedesEdges() {
  const rows = await queryOne<{ in: unknown; out: unknown }>(
    /* surql */ `
    SELECT in, out FROM relates_to WHERE relation_type = 'supersedes'
    `,
  );
  return rows.map((r) => ({ from: String(r.in), to: String(r.out) }));
}
