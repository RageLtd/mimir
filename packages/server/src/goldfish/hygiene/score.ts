/**
 * Forgetting score — pure scoring and selection for the hygiene prune pass.
 *
 * A memory's value combines three signals:
 *   - confidence: how much we trust it (decayed over sweeps when untouched)
 *   - freshness:  exponential decay on time since last access
 *   - access:     a saturating bonus for how often it's been retrieved
 *
 * Unlike the retrieval-side freshness (store.ts computeFreshness, floored at
 * 0.1 so old memories still surface), the forgetting freshness is unfloored:
 * the whole point of the prune pass is to let genuinely cold memories keep
 * sinking until they fall through the floor and get reaped.
 *
 * All time is injected (nowMs) so the logic is deterministic under test.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Freshness half-life: a memory untouched for this many days is worth half. */
const HALF_LIFE_DAYS = 30;
/** Access saturation constant — higher K means more accesses needed to count. */
const ACCESS_SATURATION_K = 3;

/** Memory types the prune pass must never touch. Facts are the only fair game;
 *  summaries anchor compaction, and playbook/skill memories are the generated
 *  procedures the skill layer will depend on. */
const PROTECTED_TYPES = new Set(["summary", "playbook", "skill"]);

export interface ScoreInput {
  readonly confidence?: number;
  readonly last_accessed?: string;
  readonly access_count?: number;
  readonly created_at?: string;
}

function toMs(iso: string | undefined, fallbackMs: number) {
  if (!iso) return fallbackMs;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? fallbackMs : ms;
}

/** Score a memory in [0, 1]. Higher = more worth keeping. */
export function scoreMemory(input: ScoreInput, nowMs: number) {
  const confidence = input.confidence ?? 1;
  const accessCount = input.access_count ?? 0;

  const lastAccessedMs = toMs(
    input.last_accessed,
    toMs(input.created_at, nowMs),
  );
  const daysSinceAccess = Math.max(0, (nowMs - lastAccessedMs) / DAY_MS);
  const freshness = Math.exp((-daysSinceAccess * Math.LN2) / HALF_LIFE_DAYS);

  // 0.5 (never accessed) → 1.0 (heavily accessed), saturating.
  const accessFactor =
    0.5 + 0.5 * (accessCount / (accessCount + ACCESS_SATURATION_K));

  return confidence * freshness * accessFactor;
}

export interface PruneCandidate extends ScoreInput {
  readonly id: string;
  readonly content: string;
  readonly type?: string;
}

export interface PruneSelection {
  readonly id: string;
  readonly content: string;
  readonly score: number;
  readonly ageDays: number;
  readonly reason: string;
}

export interface SelectOpts {
  readonly scoreFloor: number;
  readonly minAgeDays: number;
  readonly maxPrunes: number;
  readonly now: number;
}

/**
 * Choose which memories to prune. A memory is eligible only when it is a plain
 * fact, older than minAgeDays, and scores below scoreFloor. Results are sorted
 * worst-first and capped at maxPrunes so a single sweep can never over-cut.
 */
export function selectForPruning(
  candidates: readonly PruneCandidate[],
  opts: SelectOpts,
): PruneSelection[] {
  const eligible: PruneSelection[] = [];

  for (const c of candidates) {
    if (c.type && PROTECTED_TYPES.has(c.type)) continue;

    const createdMs = toMs(c.created_at, opts.now);
    const ageDays = (opts.now - createdMs) / DAY_MS;
    if (ageDays < opts.minAgeDays) continue;

    const score = scoreMemory(c, opts.now);
    if (score >= opts.scoreFloor) continue;

    eligible.push({
      id: c.id,
      content: c.content,
      score,
      ageDays,
      reason: `score ${score.toFixed(4)} < floor ${opts.scoreFloor}, age ${ageDays.toFixed(0)}d`,
    });
  }

  return eligible.sort((a, b) => a.score - b.score).slice(0, opts.maxPrunes);
}
