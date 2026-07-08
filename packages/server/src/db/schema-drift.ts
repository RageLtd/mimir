import type { Surreal } from "surrealdb";
import { config } from "../config";
import { log } from "../util/logger";

/**
 * Schema drift guards.
 *
 * The cart_* convergence machinery this module was born for left with
 * MIM-91 (the cartographer index is local now); what remains is the
 * embedding-index dimension guard for the memory table.
 */

/**
 * Pure: extract the DIMENSION value from an HNSW index definition string
 * (as returned by INFO FOR TABLE). Null when absent. Exported for tests.
 */
export const parseIndexDimension = (definition: string) => {
  const match = definition.match(/DIMENSION (\d+)/);
  return match?.[1] ? parseInt(match[1], 10) : null;
};

/**
 * Guard the HNSW index dimension against config.embedding.dimensions.
 * `DEFINE ... IF NOT EXISTS` never updates an existing index, so a config
 * change (new embedder) silently mismatches otherwise — vector search then
 * fails or degrades with no obvious cause.
 *
 * Empty memory table → redefine automatically (nothing to lose; this is
 * the blank-instance / fresh-deploy path). Populated table → LOUD error
 * and leave the index alone: the operator must re-embed the corpus
 * (scripts/reembed-import.ts) before the new dimension is usable.
 */
export const ensureEmbeddingIndexDimension = async (db: Surreal) => {
  const [info] = await db.query<[{ indexes: Record<string, string> } | null]>(
    `INFO FOR TABLE memory`,
  );
  const definition = info?.indexes?.memory_vec;
  if (!definition) return;

  const live = parseIndexDimension(definition);
  const wanted = config.embedding.dimensions;
  if (live === null || live === wanted) return;

  const [countRow] = await db.query<[Array<{ count: number }>]>(
    `SELECT count() AS count FROM memory WHERE embedding != NONE GROUP ALL`,
  );
  const embedded = countRow?.[0]?.count ?? 0;

  if (embedded > 0) {
    log.error(
      { live, wanted, embedded },
      "HNSW dimension mismatch on a populated memory table — re-embed the corpus (scripts/reembed-import.ts) before changing EMBED_DIMENSIONS; index left unchanged",
    );
    return;
  }

  await db.query(`
    REMOVE INDEX IF EXISTS memory_vec ON TABLE memory;
    DEFINE INDEX memory_vec ON memory FIELDS embedding
      HNSW DIMENSION ${wanted} DIST COSINE;
  `);
  log.warn(
    { from: live, to: wanted },
    "redefined memory_vec HNSW index for new embedding dimensions (table was empty)",
  );
};
