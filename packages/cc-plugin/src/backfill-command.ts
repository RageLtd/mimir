/**
 * `mimir-cc embed-backfill` — vectorize replica rows without embeddings
 * (imported corpus + rows stored while the embedder was absent). Safe to
 * re-run any time; already-embedded rows are never touched.
 */

import { backfillEmbeddings } from "@mimir/plugin-core/brain/backfill";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";

export const runBackfillCommand = async () => {
  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  const replica = createOrgReplica(replicaPath);
  console.log(`Backfilling embeddings in ${replicaPath}`);

  const result = await backfillEmbeddings(replica, (msg) =>
    console.log(`  ${msg}`),
  );
  replica.close();

  if (result.error) {
    console.error(
      `Backfill failed after ${result.embedded} embeddings: ${result.error}`,
    );
    return 1;
  }
  console.log(
    result.embedded === 0
      ? "Nothing to do — every memory already has a vector."
      : `Done — ${result.embedded} memories embedded.`,
  );
  return 0;
};
