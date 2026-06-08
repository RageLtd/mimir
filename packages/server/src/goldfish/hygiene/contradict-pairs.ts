/**
 * Pure candidate selection and outcome routing for the contradiction pass.
 *
 * Consolidation handles near-duplicates (distance <= mergeDistance) by fusing
 * them. Contradiction operates strictly ABOVE that band — pairs in
 * (mergeDistance, contradictionDistance] are close enough to be about the same
 * subject but too far apart to be "the same fact," which is exactly where a
 * superseding correction tends to land. Keeping the bands disjoint means a pair
 * is never both merged and demoted in one sweep.
 *
 * No I/O here — neighbour edges and existing supersedes edges are gathered by
 * the caller and passed in, so this logic is deterministic under test.
 */

import { assertNever } from "../../util/assert";
import type { NeighborEdge } from "./cluster";

/** Undirected key for a pair of memory ids — order-independent so (a,b) and
 *  (b,a) collapse to one entry. */
export function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface CandidatePair {
  readonly a: string;
  readonly b: string;
  readonly distance: number;
}

export interface SelectPairsOpts {
  /** Exclusive lower bound — pairs at or below this belong to consolidation. */
  readonly mergeDistance: number;
  /** Inclusive upper bound on how far apart a contradiction can sit. */
  readonly contradictionDistance: number;
  /** Undirected keys (see pairKey) of pairs that already carry a supersedes
   *  edge. Skipped so a confirmed contradiction is demoted once, not every
   *  sweep. */
  readonly alreadySuperseded?: ReadonlySet<string>;
}

/**
 * Reduce a raw neighbour-edge list to the pairs worth judging this sweep:
 * deduped (undirected, keeping the tightest distance), filtered to the
 * contradiction band, stripped of pairs already superseded, and sorted
 * tightest-first (most likely to be a real conflict). The caller applies the
 * per-sweep check budget so it can report exactly how many were deferred.
 */
export function selectContradictionPairs(
  edges: readonly NeighborEdge[],
  opts: SelectPairsOpts,
) {
  const seen = new Map<string, CandidatePair>();
  const excluded = opts.alreadySuperseded ?? new Set<string>();

  for (const edge of edges) {
    if (edge.a === edge.b) continue;
    if (edge.distance <= opts.mergeDistance) continue;
    if (edge.distance > opts.contradictionDistance) continue;

    const key = pairKey(edge.a, edge.b);
    if (excluded.has(key)) continue;

    // Order the pair deterministically so winner/loser routing downstream is
    // stable regardless of which direction the edge was discovered from.
    const [a, b] = edge.a < edge.b ? [edge.a, edge.b] : [edge.b, edge.a];
    const existing = seen.get(key);
    if (!existing || edge.distance < existing.distance) {
      seen.set(key, { a, b, distance: edge.distance });
    }
  }

  return [...seen.values()].sort(
    (x, y) =>
      x.distance - y.distance ||
      pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)),
  );
}

/** What the judge decided to do with a candidate pair:
 *  - "merge": same thing / supersession-with-detail → fuse losslessly.
 *  - "demote": factual conflict, one side is now wrong → keep survivor, demote loser.
 *  - "leave": unrelated, independently true, or undecided → do nothing. */
export type PairAction = "merge" | "demote" | "leave";

/** The judge's ruling. survivor is 1-indexed against the (a, b) order the pair
 *  was presented in, and only meaningful for "demote"; null means the judge
 *  could not pick which side is correct. */
export interface PairVerdict {
  readonly action: PairAction;
  readonly survivor: 1 | 2 | null;
}

/** Concrete routing for a pair — what runContradiction should actually do. */
export type PairRouting =
  | { readonly kind: "merge" }
  | {
      readonly kind: "demote";
      readonly winnerId: string;
      readonly loserId: string;
    }
  | { readonly kind: "leave" };

/**
 * Map a verdict onto a concrete action. Conservative by construction: a
 * "demote" with no decided survivor collapses to "leave" — the documented
 * failure mode is demoting the RIGHT fact, so when the judge can't pick a
 * loser, we touch nothing.
 */
export function routePair(pair: CandidatePair, verdict: PairVerdict) {
  switch (verdict.action) {
    case "merge":
      return { kind: "merge" as const };
    case "demote":
      if (verdict.survivor === 1)
        return { kind: "demote" as const, winnerId: pair.a, loserId: pair.b };
      if (verdict.survivor === 2)
        return { kind: "demote" as const, winnerId: pair.b, loserId: pair.a };
      return { kind: "leave" as const };
    case "leave":
      return { kind: "leave" as const };
    default:
      return assertNever(verdict.action);
  }
}
