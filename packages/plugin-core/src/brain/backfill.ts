/**
 * Embedding backfill (MIM-85) — vectorizes replica rows that lack one.
 * Two populations need this: the imported corpus (import-replica.ts drops
 * vectors deliberately — they're model-space-bound) and any rows stored
 * while the embedder was absent/cold.
 *
 * Uses the patient spawn-wait (this is a batch command, not a hook) and
 * the shared memoryEmbedSource rule so backfilled vectors are
 * byte-identical in derivation to store-time ones.
 */

import { memoryEmbedSource, type OrgReplica } from "../store/org-replica";
import { embedTexts } from "./embedder";

const BATCH_SIZE = 64;
/** A 64-text batch of memory-sized inputs is seconds on a GPU and can be
 *  minutes on CPU; this is a batch job, so wait for it rather than fail. */
const BATCH_EMBED_TIMEOUT_MS = 120_000;

export const backfillEmbeddings = async (
  replica: OrgReplica,
  log: (message: string) => void,
) => {
  let embedded = 0;
  for (;;) {
    const batch = replica.listUnembedded(BATCH_SIZE);
    if (batch.length === 0) break;

    const vectors = await embedTexts(batch.map(memoryEmbedSource), {
      embedTimeoutMs: BATCH_EMBED_TIMEOUT_MS,
    });
    if (vectors === null) {
      return {
        embedded,
        error:
          "embedding failed — see the [mimir-embedder] line on stderr: not installed means `mimir-cc update`; a timeout means this batch is too slow for the running server (CPU-only build? re-run `mimir-cc update` to pick up the GPU variant)",
      };
    }

    let persisted = 0;
    for (const [i, row] of batch.entries()) {
      const vector = vectors[i];
      if (vector && replica.setEmbedding(row.id, vector)) persisted++;
    }
    if (persisted === 0) {
      // Rows came back but none accepted a vector — without this guard a
      // persistence bug would loop forever on the same batch.
      return {
        embedded,
        error: `no progress: ${batch.length} unembedded rows but 0 vectors persisted`,
      };
    }
    embedded += persisted;
    log(`embedded ${embedded} memories…`);
  }
  return { embedded, error: null };
};
