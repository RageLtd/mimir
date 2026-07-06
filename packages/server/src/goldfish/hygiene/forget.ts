/**
 * Forgetting pass — apply a confidence decay to memories untouched since the
 * last sweep, then prune the ones whose combined value has fallen through the
 * floor.
 *
 * Decay is folded into the in-memory scoring BEFORE selection, so the dry-run
 * report shows exactly what a live run would prune — not a pre-decay snapshot.
 */

import type { OrgScope } from "../../db/scope";
import { deleteMemory, type Memory } from "../store";
import { decayUntouchedConfidence } from "../store-hygiene";
import { type PruneCandidate, selectForPruning } from "./score";

export interface ForgettingOpts {
  readonly dryRun: boolean;
  readonly scoreFloor: number;
  readonly minAgeDays: number;
  readonly maxPrunes: number;
  readonly confidenceDecay: number;
  /** Memories not accessed within this many seconds get the decay. */
  readonly decayOlderThanSeconds: number;
  readonly now: number;
}

export interface PruneResult {
  readonly id: string;
  readonly content: string;
  readonly score: number;
  readonly ageDays: number;
  readonly reason: string;
  readonly applied: boolean;
}

export interface ForgettingReport {
  readonly scanned: number;
  readonly decayedCount: number;
  readonly prunedCount: number;
  readonly prunes: PruneResult[];
}

function msOf(iso: string | undefined, fallback: number) {
  if (!iso) return fallback;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? fallback : ms;
}

export async function runForgetting(
  scope: OrgScope,
  memories: Memory[],
  opts: ForgettingOpts,
) {
  const cutoffMs = opts.now - opts.decayOlderThanSeconds * 1000;

  // Project the decay into scoring inputs so selection reflects post-decay
  // confidence whether or not we actually write it this run.
  const candidates: PruneCandidate[] = memories.map((m) => {
    const lastMs = msOf(m.last_accessed, msOf(m.created_at, opts.now));
    const untouched = lastMs < cutoffMs;
    const confidence =
      (m.confidence ?? 1) * (untouched ? opts.confidenceDecay : 1);
    return {
      id: m.id ?? "",
      content: m.content,
      type: m.type,
      confidence,
      access_count: m.access_count,
      last_accessed: m.last_accessed,
      created_at: m.created_at,
    };
  });

  const selected = selectForPruning(candidates, {
    scoreFloor: opts.scoreFloor,
    minAgeDays: opts.minAgeDays,
    maxPrunes: opts.maxPrunes,
    now: opts.now,
  });

  let decayedCount = 0;
  if (!opts.dryRun) {
    decayedCount = await decayUntouchedConfidence(
      scope,
      opts.confidenceDecay,
      opts.decayOlderThanSeconds,
    );
  }

  const prunes: PruneResult[] = [];
  for (const s of selected) {
    let applied = false;
    if (!opts.dryRun && s.id) {
      applied = await deleteMemory(scope, s.id);
    }
    prunes.push({ ...s, applied });
  }

  return {
    scanned: memories.length,
    decayedCount,
    prunedCount: opts.dryRun
      ? selected.length
      : prunes.filter((p) => p.applied).length,
    prunes,
  };
}
