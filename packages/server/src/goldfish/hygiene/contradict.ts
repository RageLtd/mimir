/**
 * Contradiction pass — judge fact pairs that are close in topic and route each
 * to one of three actions: MERGE, DEMOTE, or LEAVE.
 *
 * It operates strictly ABOVE consolidation's blind-merge band: pairs in
 * (mergeDistance, contradictionDistance]. Near-duplicates at or below
 * mergeDistance are consolidation's job (distance-trusted, no judge). In this
 * band distance can't tell "same thing / supersession-with-detail" (wants a
 * lossless merge) from "factual conflict" (wants a demote) — only the judge
 * can — so the judge decides:
 *
 *  - MERGE → fuse losslessly via the SAME proven path consolidation uses
 *    (mergeMemoriesText → applyMerge). This is the claim-level-granularity fix:
 *    a detailed memory whose one stale sub-claim was superseded is preserved by
 *    fusing, not blunted by a wholesale demote.
 *  - DEMOTE → keep the surviving truth, add a `supersedes` edge winner→loser,
 *    and multiply the loser's confidence by demotionFactor. NEVER deletes; the
 *    lowered confidence sinks the loser in retrieval and feeds the prune pass.
 *  - LEAVE → untouched (unrelated, both true, or the judge can't pick a loser).
 *
 * Within one sweep a memory is acted on at most once (a merge deletes its
 * members; a demoted loser is excluded from later pairs) — the `consumed` set
 * gives contradiction the disjointness consolidation gets free from clustering.
 */

import type { OrgScope } from "../../db/scope";
import { assertNever } from "../../util/assert";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import { createRelation, findNeighbors, type Memory } from "../store";
import { demoteConfidence, listSupersedesEdges } from "../store-hygiene";
import type { NeighborEdge } from "./cluster";
import { applyMerge, type MergeProposal } from "./consolidate";
import {
  pairKey,
  routePair,
  selectContradictionPairs,
} from "./contradict-pairs";
import { classifyPair, mergeMemoriesText } from "./llm";

/** Neighbours fetched per fact when building the candidate edge list. */
const NEIGHBORS_PER_FACT = 5;

export interface ContradictionOpts {
  readonly dryRun: boolean;
  /** Band floor (exclusive) — pairs at or below this are consolidation's. */
  readonly mergeDistance: number;
  /** Band ceiling (inclusive) — how far apart a contradiction can sit. */
  readonly contradictionDistance: number;
  /** Hard cap on judge calls per sweep — each candidate pair costs one. */
  readonly maxChecks: number;
  /** Multiply the loser's confidence by this on a confirmed contradiction. */
  readonly demotionFactor: number;
}

export interface DemotionProposal {
  readonly winnerId: string;
  readonly loserId: string;
  readonly winnerContent: string;
  readonly loserContent: string;
  readonly distance: number;
  /** The judge's one-line rationale — surfaced for dry-run tuning and the
   *  armed-run audit. */
  readonly reason: string;
  readonly applied: boolean;
  readonly demotedTo?: number;
  readonly error?: string;
}

export interface ContradictionReport {
  /** Candidate pairs judged this sweep (after band filter, dedup, and cap). */
  readonly pairsConsidered: number;
  /** True when in-band pairs exceeded maxChecks — the rest wait for next sweep
   *  rather than being silently dropped. */
  readonly capped: boolean;
  /** Pairs the judge ruled a factual conflict — keep survivor, demote loser. */
  readonly demotions: DemotionProposal[];
  /** Pairs the judge ruled the same thing / lossless supersession — fused via
   *  the consolidation merge path instead of demoted. */
  readonly merges: MergeProposal[];
  readonly contradictionDistanceUsed: number;
  readonly factsConsidered: number;
}

/** Build the candidate edge list among fact memories: each fact's neighbours
 *  out to contradictionDistance become edges. The pure selector filters these
 *  down to the contradiction band and drops already-superseded pairs. */
async function buildContradictionEdges(
  scope: OrgScope,
  facts: Memory[],
  contradictionDistance: number,
) {
  // SurrealDB returns ids as RecordId objects; stringify everything before it
  // touches a Set/edge so cross-row comparisons don't silently fail by
  // reference (the same trap consolidate.ts buildEdges documents).
  const factIds = new Set(facts.map((m) => String(m.id)));
  const edges: NeighborEdge[] = [];

  for (const m of facts) {
    if (!m.id || m.embedding.length === 0) continue;
    const sourceId = String(m.id);
    const neighbors = await findNeighbors(
      scope,
      m.embedding,
      m.id,
      NEIGHBORS_PER_FACT,
      contradictionDistance,
    );
    for (const n of neighbors) {
      const nid = n.id ? String(n.id) : "";
      if (!nid || nid === sourceId || !factIds.has(nid)) continue;
      edges.push({ a: sourceId, b: nid, distance: n.distance });
    }
  }

  return edges;
}

export async function runContradiction(
  scope: OrgScope,
  memories: Memory[],
  opts: ContradictionOpts,
) {
  const byId = new Map<string, Memory>();
  for (const m of memories) if (m.id) byId.set(String(m.id), m);

  const allFacts = memories.filter(
    (m) => (m.type ?? "fact") === "fact" && m.id && m.embedding.length > 0,
  );

  const existing = await listSupersedesEdges(scope);
  const alreadySuperseded = new Set(existing.map((e) => pairKey(e.from, e.to)));
  // A memory already superseded (the loser end of a supersedes edge) is stale
  // and awaiting prune — exclude it from candidacy entirely. Otherwise a later
  // "merge" verdict could fuse it into a fresh canonical and RESURRECT the claim
  // a prior sweep demoted (and sever its supersedes edge, at the winner's
  // confidence). Supersession is a 3-way relationship the pairwise judge can't
  // see; this tombstones the loser. The first three-way dry-run caught exactly
  // this on two demoted losers.
  const supersededLosers = new Set(existing.map((e) => e.to));
  const facts = allFacts.filter((m) => !supersededLosers.has(String(m.id)));

  const edges = await buildContradictionEdges(
    scope,
    facts,
    opts.contradictionDistance,
  );

  const allPairs = selectContradictionPairs(edges, {
    mergeDistance: opts.mergeDistance,
    contradictionDistance: opts.contradictionDistance,
    alreadySuperseded,
  });

  const capped = allPairs.length > opts.maxChecks;
  const candidates = allPairs.slice(0, opts.maxChecks);

  const demotions: DemotionProposal[] = [];
  const merges: MergeProposal[] = [];
  // A memory acted on this sweep (merged away, or demoted as a loser) must not
  // be touched again — contradiction's candidate pairs can overlap, unlike
  // consolidation's disjoint clusters.
  const consumed = new Set<string>();

  for (const pair of candidates) {
    if (consumed.has(pair.a) || consumed.has(pair.b)) continue;

    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    if (!a || !b) continue;

    const verdict = await classifyPair(a.content, b.content);
    if (!verdict) continue; // classifier failed/unparseable — leave the pair alone

    const routing = routePair(pair, verdict);
    switch (routing.kind) {
      case "leave":
        break;

      case "demote": {
        const winner = byId.get(routing.winnerId);
        const loser = byId.get(routing.loserId);
        if (!winner || !loser) break;
        consumed.add(routing.loserId);

        const base = {
          winnerId: routing.winnerId,
          loserId: routing.loserId,
          winnerContent: winner.content,
          loserContent: loser.content,
          distance: pair.distance,
          reason: verdict.reason,
        };

        if (opts.dryRun) {
          demotions.push({ ...base, applied: false });
          break;
        }

        const result = await applyDemotion(
          scope,
          routing.winnerId,
          routing.loserId,
          opts.demotionFactor,
          pair.distance,
        );
        demotions.push({
          ...base,
          applied: result.ok,
          demotedTo: result.ok ? result.demotedTo : undefined,
          error: result.ok ? undefined : result.error,
        });
        break;
      }

      case "merge": {
        consumed.add(pair.a);
        consumed.add(pair.b);
        merges.push(await proposePairMerge(scope, a, b, opts.dryRun));
        break;
      }

      default:
        assertNever(routing);
    }
  }

  if (capped) {
    log.info(
      {
        inBand: allPairs.length,
        judged: candidates.length,
        cap: opts.maxChecks,
      },
      "contradiction hit per-sweep check cap — remaining pairs deferred to next sweep",
    );
  }

  return {
    pairsConsidered: candidates.length,
    capped,
    demotions,
    merges,
    contradictionDistanceUsed: opts.contradictionDistance,
    factsConsidered: facts.length,
  } satisfies ContradictionReport;
}

/**
 * Record a contradiction without deleting anything: add the supersedes edge,
 * then demote the loser's confidence. Edge-before-demote so any crash between
 * them is harmless (a stray edge or an un-demoted fact — never data loss).
 * Never throws; each step is isolated so one DB hiccup can't abort the pass.
 */
async function applyDemotion(
  scope: OrgScope,
  winnerId: string,
  loserId: string,
  factor: number,
  distance: number,
) {
  const [edgeErr] = await attempt(() =>
    createRelation(
      scope,
      winnerId,
      loserId,
      Math.max(0, 1 - distance),
      "supersedes",
    ),
  );
  if (edgeErr) {
    return {
      ok: false as const,
      error: `supersedes edge failed: ${edgeErr.message}`,
    };
  }

  const [demoteErr, demotedTo] = await attempt(() =>
    demoteConfidence(scope, loserId, factor),
  );
  if (demoteErr) {
    return {
      ok: false as const,
      error: `demotion failed: ${demoteErr.message}`,
    };
  }
  if (demotedTo === null) {
    return { ok: false as const, error: "loser not found for demotion" };
  }

  return { ok: true as const, demotedTo };
}

/**
 * Fuse a judge-routed "merge" pair via the same proven path consolidation uses:
 * mergeMemoriesText writes the canonical, applyMerge creates it + deletes the
 * members + relinks. Returns a MergeProposal for the report (dry-run stops after
 * the canonical text; nothing mutates). Never throws — a model decline or DB
 * hiccup becomes an unapplied proposal with an error, so the sweep continues.
 */
async function proposePairMerge(
  scope: OrgScope,
  a: Memory,
  b: Memory,
  dryRun: boolean,
) {
  const members = [a, b];
  const memberIds = members.map((m) => String(m.id));
  const memberContents = members.map((m) => m.content);

  const canonicalText = await mergeMemoriesText(memberContents);
  if (!canonicalText) {
    return {
      memberIds,
      memberContents,
      canonicalText: "",
      applied: false,
      error: "model declined or failed to merge",
    } satisfies MergeProposal;
  }

  if (dryRun) {
    return {
      memberIds,
      memberContents,
      canonicalText,
      applied: false,
    } satisfies MergeProposal;
  }

  const [err, result] = await attempt(() =>
    applyMerge(scope, members, canonicalText),
  );
  if (err || !result) {
    return {
      memberIds,
      memberContents,
      canonicalText,
      applied: false,
      error: `merge failed: ${err?.message ?? "unknown"}`,
    } satisfies MergeProposal;
  }
  if (!result.ok) {
    return {
      memberIds,
      memberContents,
      canonicalText,
      applied: false,
      error: result.error,
    } satisfies MergeProposal;
  }

  return {
    memberIds,
    memberContents,
    canonicalText,
    applied: true,
    canonicalId: result.canonicalId,
  } satisfies MergeProposal;
}
