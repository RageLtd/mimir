import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { OrgScope } from "../db/scope";
import { log } from "../util/logger";
import { modelContentToString } from "../util/model-message";
import { embedOne } from "./clients";
import {
  computeFreshness,
  getRelatedMemories,
  type Memory,
  searchByText,
  searchByVector,
  touchMemories,
} from "./store";

/**
 * Build a search query from the most recent user messages.
 */
function buildQuery(messages: ModelMessage[]) {
  return messages
    .filter((m) => m.role === "user" && modelContentToString(m.content))
    .slice(-3)
    .map((m) => modelContentToString(m.content) ?? "")
    .join("\n");
}

/**
 * Retrieve relevant memories for the current conversation (global search).
 *
 * Tuning knobs:
 *   topK         — cap on base memories kept after scoring (default 10).
 *                  Per-turn callers like /v1/context/retrieve pass a much
 *                  smaller value (3) so the injection doesn't bloat every
 *                  user message; the boot-context / assemble path keeps
 *                  the default for richer first-turn priming.
 *   includeRelated — fold graph-neighbour memories into the result.
 *                    Default true (matches prior behaviour); per-turn
 *                    retrieval passes false to keep the budget tight.
 */
/** Additive score bonus for memories matching the active project.
 * Strictly a tiebreaker — a highly relevant cross-project memory must
 * beat a tangentially related same-project memory. */
const PROJECT_MATCH_BONUS = 0.02;

type RetrieveOpts = {
  readonly topK?: number;
  readonly includeRelated?: boolean;
  /** Canonical project UUID. When set, same-project memories get a
   * light scoring boost (tiebreaker, not filter). */
  readonly projectId?: string;
};

/**
 * Combine the retrieval signals into one rank score.
 *
 * Confidence is a multiplier so a demoted/superseded fact (the contradiction
 * pass drives confidence down) sinks below an equal-relevance high-confidence
 * one, and routine untouched-decay gently downranks stale facts. The project
 * match is an additive tiebreaker outside the multiply so it can't be scaled
 * away. combinedScore falls back to 0.5 for a candidate that matched neither
 * search cleanly, keeping a stray match ranked rather than zeroed.
 */
export function scoreRetrievalCandidate(opts: {
  readonly combinedScore: number;
  readonly freshness: number;
  readonly confidence: number;
  readonly projectBonus: number;
}) {
  return (
    (opts.combinedScore || 0.5) * opts.freshness * opts.confidence +
    opts.projectBonus
  );
}

export async function retrieveMemoryList(
  scope: OrgScope,
  messages: ModelMessage[],
  opts: RetrieveOpts = {},
) {
  const start = Date.now();
  const topK = opts.topK ?? 10;
  const includeRelated = opts.includeRelated ?? true;
  const projectId = opts.projectId;
  const query = buildQuery(messages);
  if (!query) {
    log.debug("no user messages for memory query, skipping retrieval");
    return null;
  }

  log.debug({ queryChars: query.length }, "retrieving memories");

  // "query" purpose — asymmetric embedders (Cohere) embed retrieval
  // queries differently from stored documents.
  const queryEmbedding = await embedOne(query, "query");
  if (!queryEmbedding) {
    log.warn("failed to embed memory query, skipping retrieval");
    return null;
  }

  const [vectorResults, textResults] = await Promise.all([
    searchByVector(scope, queryEmbedding, 30),
    searchByText(scope, query, 20),
  ]);

  const seen = new Set<string>();
  const candidates = [...vectorResults, ...textResults].filter((m) => {
    // Playbooks have their own surfacing paths (always-injected index +
    // trigger-matched ambient bodies, see goldfish/playbook.ts) on a budget
    // separate from facts. Excluding them here keeps the two from crowding
    // each other out of the shared top-K and avoids double-injection.
    if (m.type === "playbook") return false;
    if (!m.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  log.debug(
    {
      vectorResults: vectorResults.length,
      textResults: textResults.length,
      dedupedCandidates: candidates.length,
    },
    "memory search results",
  );

  if (candidates.length === 0) {
    log.debug("no memory candidates found");
    return null;
  }

  // Score candidates using vector distance + text score + freshness
  // Vector results have 'distance' (lower = better), text results have 'score' (higher = better)
  const scoredMemories = candidates
    .map((m) => {
      if (!m.id) return null;

      // Distance score: convert to similarity (0-1, higher = better)
      const distance = (m as Memory & { distance?: number }).distance;
      const vectorScore =
        distance !== undefined ? 1 - Math.min(distance, 1) : 0;

      // Text search score: normalize (assume scores are 0-10 range)
      const textScore = ((m as Memory & { score?: number }).score ?? 0) / 10;

      // Combine: vector results get 0.7 weight, text results get 0.3 weight
      // If a memory appears in both, it gets both scores
      const combinedScore = Math.max(vectorScore * 0.7, textScore * 0.3);

      const freshness = computeFreshness(m.last_accessed);
      const projectBonus =
        projectId && m.project_id === projectId ? PROJECT_MATCH_BONUS : 0;
      const finalScore = scoreRetrievalCandidate({
        combinedScore,
        freshness,
        confidence: m.confidence ?? 1,
        projectBonus,
      });

      return { id: m.id, content: m.content, score: finalScore };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const topMemories = scoredMemories
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((m) => m.score > 0.05);

  if (topMemories.length === 0) {
    log.debug(
      { totalScored: scoredMemories.length, topK },
      "all memories below score threshold",
    );
    return null;
  }

  const topIds = topMemories.map((m) => m.id);
  const related = includeRelated
    ? await getRelatedMemories(scope, topIds, 5)
    : [];

  const allAccessedIds = [
    ...topIds,
    ...(related.map((m) => m.id).filter(Boolean) as string[]),
  ];
  touchMemories(scope, allAccessedIds).catch((e) =>
    log.error({ err: e }, "failed to touch memories"),
  );

  const allMemories = [
    ...topMemories.map((m) => m.content),
    ...related.map((m) => `[related] ${m.content}`),
  ];

  log.info(
    {
      topMemories: topMemories.length,
      related: related.length,
      topK,
      includeRelated,
      topScores: topMemories
        .slice(0, 3)
        .map((m) => ({ score: m.score.toFixed(4), content: m.content })),
      elapsed: `${Date.now() - start}ms`,
    },
    "memory retrieval complete",
  );

  return allMemories;
}

/** Render a retrieved memory list as the bullet block callers inject into prompts. */
export function formatMemoryList(memories: string[]) {
  return memories.map((m) => `- ${m}`).join("\n");
}

/**
 * String-rendered variant of retrieveMemoryList — the shape every prompt
 * injection call site consumes. Callers that need the true memory count
 * (e.g. /file-info's memoryCount) use retrieveMemoryList directly; memory
 * contents are multi-line, so counting lines of this string lies.
 */
export async function retrieveMemories(
  scope: OrgScope,
  messages: ModelMessage[],
  opts: RetrieveOpts = {},
) {
  const memories = await retrieveMemoryList(scope, messages, opts);
  return memories ? formatMemoryList(memories) : null;
}
