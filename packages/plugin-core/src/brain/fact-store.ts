/**
 * Where extracted facts land: the local org replica, with the query
 * embedder for dedupe and linking, attributed to the active project.
 * Shared by every host's distil path so the store loop is written once.
 */

import type { Logger } from "../logger";
import { attempt } from "../result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
  type OrgReplica,
} from "../store/org-replica";
import { storeTyped } from "../tools/org-memory";
import { createEmbedQuery } from "./embedder";
import type { EmbedQuery } from "./retrieve";

export type FactStore = {
  readonly projectId: string | null;
  readonly replica: OrgReplica;
  readonly embedQuery: EmbedQuery;
};

/** Opens the replica (`MIMIR_ORG_REPLICA_DB` or the default path); the
 *  caller closes `replica` when done. */
export const openFactStore = async (projectId: string | null) => ({
  projectId,
  replica: createOrgReplica(
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
  ),
  embedQuery: createEmbedQuery(),
});

/** Stores each memory as a project fact, in order. A failed store is
 *  logged and skipped; the replica is left open. */
export const storeFacts = async (
  store: FactStore,
  memories: readonly string[],
  log: Logger,
  deps = { storeTyped },
) => {
  let stored = 0;
  let duplicates = 0;
  for (const memory of memories) {
    const [storeErr, result] = await attempt(() =>
      deps.storeTyped(store.replica, store.embedQuery, {
        content: memory,
        type: "fact",
        ...(store.projectId ? { project: store.projectId } : {}),
      }),
    );
    if (storeErr) {
      log.warn("memory store failed", { error: storeErr.message });
      continue;
    }
    if (result.stored) stored++;
    else duplicates++;
  }
  return { stored, duplicates };
};
