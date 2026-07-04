/**
 * Consolidation pass — find clusters of near-duplicate fact memories, ask the
 * hygiene model to fuse each into one canonical statement, and (unless dry-run)
 * replace the cluster with that canonical memory.
 *
 * Clustering reuses the existing HNSW index via findNeighbors, so we don't
 * recompute pairwise distances ourselves.
 */

import { log } from "../../util/logger";
import { embedOne } from "../clients";
import {
  createRelation,
  deleteMemory,
  findNeighbors,
  type Memory,
} from "../store";
import { createCanonicalMemory } from "../store-hygiene";
import { groupClusters, type NeighborEdge } from "./cluster";
import { mergeMemoriesText } from "./llm";

export interface ConsolidationOpts {
  readonly dryRun: boolean;
  readonly mergeDistance: number;
  readonly maxClusterSize: number;
  readonly maxMergesPerSweep: number;
}

export interface MergeProposal {
  readonly memberIds: string[];
  readonly memberContents: string[];
  readonly canonicalText: string;
  readonly applied: boolean;
  readonly canonicalId?: string;
  readonly error?: string;
}

export interface ConsolidationReport {
  readonly clustersFound: number;
  /** Clusters actually sent to the model this sweep (bounded by the cap). */
  readonly processed: number;
  /** True when clustersFound exceeded the cap — some clusters were left for
   *  the next sweep rather than silently dropped. */
  readonly capped: boolean;
  readonly merged: number;
  readonly proposals: MergeProposal[];
  /** The merge distance actually applied this sweep (confirms env config
   *  propagated, records what threshold a given report was produced at) and the
   *  number of fact memories considered. */
  readonly mergeDistanceUsed: number;
  readonly factsConsidered: number;
}

/** Build the near-neighbour edge list among fact memories: each fact's
 *  neighbours within mergeDistance become clustering edges. */
async function buildEdges(
  facts: Memory[],
  mergeDistance: number,
  maxClusterSize: number,
) {
  // SurrealDB returns `id` as RecordId objects, not strings. Set/Map membership
  // on RecordId compares by reference, so two objects meaning the same record
  // never match — every cross-row id comparison silently fails. Stringify all
  // ids before they touch a Set/Map key or an edge.
  const factIds = new Set(facts.map((m) => String(m.id)));
  const edges: NeighborEdge[] = [];

  for (const m of facts) {
    if (!m.id || m.embedding.length === 0) continue;
    const sourceId = String(m.id);
    const neighbors = await findNeighbors(
      m.embedding,
      m.id,
      maxClusterSize,
      mergeDistance,
    );
    for (const n of neighbors) {
      const nid = n.id ? String(n.id) : "";
      // Skip self (findNeighbors' own exclude also compares RecordId by
      // reference, so it can't filter the source row reliably) and non-facts.
      if (!nid || nid === sourceId || !factIds.has(nid)) continue;
      edges.push({ a: sourceId, b: nid, distance: n.distance });
    }
  }

  return edges;
}

export async function runConsolidation(
  memories: Memory[],
  opts: ConsolidationOpts,
): Promise<ConsolidationReport> {
  // Key by the stringified id — cluster member ids arrive as strings from the
  // edge list, while m.id is a RecordId object straight from the DB.
  const byId = new Map<string, Memory>();
  for (const m of memories) if (m.id) byId.set(String(m.id), m);

  const facts = memories.filter(
    (m) => (m.type ?? "fact") === "fact" && m.id && m.embedding.length > 0,
  );

  const edges = await buildEdges(
    facts,
    opts.mergeDistance,
    opts.maxClusterSize,
  );
  const clusters = groupClusters(edges, {
    mergeDistance: opts.mergeDistance,
    maxClusterSize: opts.maxClusterSize,
  });

  const proposals: MergeProposal[] = [];
  // processed bounds model calls in BOTH modes — the cap is about cost per
  // sweep, and the model call is the cost. merged counts applied merges (live
  // runs only), so it can't be the cap or dry-run would never stop calling.
  let processed = 0;
  let merged = 0;

  for (const memberIds of clusters) {
    if (processed >= opts.maxMergesPerSweep) break;

    const members = memberIds
      .map((id) => byId.get(id))
      .filter((m): m is Memory => m !== undefined);
    if (members.length < 2) continue;

    processed++;
    const memberContents = members.map((m) => m.content);
    const canonicalText = await mergeMemoriesText(memberContents);
    if (!canonicalText) {
      proposals.push({
        memberIds,
        memberContents,
        canonicalText: "",
        applied: false,
        error: "model declined or failed to merge",
      });
      continue;
    }

    if (opts.dryRun) {
      proposals.push({
        memberIds,
        memberContents,
        canonicalText,
        applied: false,
      });
      continue;
    }

    const applied = await applyMerge(members, canonicalText);
    proposals.push({
      memberIds,
      memberContents,
      canonicalText,
      applied: applied.ok,
      canonicalId: applied.canonicalId,
      error: applied.error,
    });
    if (applied.ok) merged++;
  }

  const capped = clusters.length > processed;
  if (capped) {
    log.info(
      {
        clustersFound: clusters.length,
        processed,
        cap: opts.maxMergesPerSweep,
      },
      "consolidation hit per-sweep cap — remaining clusters deferred to next sweep",
    );
  }

  return {
    clustersFound: clusters.length,
    processed,
    capped,
    merged,
    proposals,
    mergeDistanceUsed: opts.mergeDistance,
    factsConsidered: facts.length,
  };
}

/** Replace a cluster (or a judge-routed pair) with a single canonical memory.
 *  Exported so the contradiction pass can reuse this proven merge path when its
 *  judge rules a pair "merge" rather than "demote". */
export async function applyMerge(members: Memory[], canonicalText: string) {
  const embedding = await embedOne(canonicalText);
  if (!embedding) {
    return { ok: false as const, error: "failed to embed canonical text" };
  }

  const accessCount = members.reduce((s, m) => s + (m.access_count ?? 0), 0);
  const confidence = members.reduce(
    (max, m) => Math.max(max, m.confidence ?? 1),
    0,
  );
  const projectId = members.find((m) => m.project_id)?.project_id;

  const canonicalId = await createCanonicalMemory({
    content: canonicalText,
    embedding,
    project_id: projectId,
    accessCount,
    confidence,
  });
  if (!canonicalId) {
    return { ok: false as const, error: "failed to create canonical memory" };
  }

  for (const m of members) {
    if (m.id) await deleteMemory(m.id);
  }

  // Relink the canonical memory into the neighbour graph.
  const neighbors = await findNeighbors(embedding, canonicalId, 5, 0.3);
  for (const n of neighbors) {
    if (n.id)
      await createRelation(canonicalId, n.id, Math.max(0, 1 - n.distance));
  }

  return { ok: true as const, canonicalId };
}
