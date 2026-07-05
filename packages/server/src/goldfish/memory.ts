import type { ModelMessage } from "@ai-sdk/provider-utils";
import { modelContentToString } from "../agent/message-log/message-utils";
import type { BackgroundByok } from "../agent/provider/override-completion";
import { log } from "../util/logger";
import { embed, embedOne, extractMemories } from "./clients";
import {
  computeFreshness,
  createRelation,
  findDuplicate,
  findNeighbors,
  getRelatedMemories,
  type Memory,
  searchByText,
  searchByVector,
  storeMemory,
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
    searchByVector(queryEmbedding, 30),
    searchByText(query, 20),
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
  const related = includeRelated ? await getRelatedMemories(topIds, 5) : [];

  const allAccessedIds = [
    ...topIds,
    ...(related.map((m) => m.id).filter(Boolean) as string[]),
  ];
  touchMemories(allAccessedIds).catch((e) =>
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
  messages: ModelMessage[],
  opts: RetrieveOpts = {},
) {
  const memories = await retrieveMemoryList(messages, opts);
  return memories ? formatMemoryList(memories) : null;
}

/**
 * Build extraction text from a conversation.
 * Includes user messages and assistant text responses.
 * Strips tool results (raw data) and tool_call-only assistant messages
 * (just invocation noise).
 */
/** Max chars to send to the extraction model — keeps prompt eval under ~60s on Vulkan */
const EXTRACTION_MAX_CHARS = 4000;

function buildExtractionText(messages: ModelMessage[]) {
  const filtered = messages.filter((m) => {
    if (m.role === "tool") return false;
    if (m.role === "system") return false;
    const text = modelContentToString(m.content);
    if (!text) return false;
    if (m.role === "assistant" && text.trim().length < 20) {
      return false;
    }
    return true;
  });

  // Always include the last message untruncated, then fill backward with budget
  if (filtered.length === 0) return "";

  const lastMsg = filtered.at(-1);
  if (!lastMsg) return "";
  const lastLine = `${lastMsg.role}: ${modelContentToString(lastMsg.content)}`;
  const lines: string[] = [lastLine];
  let totalChars = lastLine.length;

  for (let i = filtered.length - 2; i >= 0; i--) {
    const msg = filtered[i];
    if (!msg) continue;
    const line = `${msg.role}: ${modelContentToString(msg.content)}`;
    if (totalChars + line.length > EXTRACTION_MAX_CHARS) break;
    lines.unshift(line);
    totalChars += line.length;
  }

  return lines.join("\n");
}

/**
 * Embed, dedup, store, and link a batch of memory strings.
 * Shared by extraction and compaction pipelines.
 * projectId is the canonical project ULID — a retrieval tiebreaker
 * (see PROJECT_MATCH_BONUS), not a filter.
 */
export async function storeMemoryBatch(
  memories: string[],
  projectId?: string,
): Promise<{ stored: number; duplicates: number }> {
  const embeddings = await embed(memories);
  if (!embeddings) {
    log.error("failed to embed memory batch");
    return { stored: 0, duplicates: 0 };
  }

  let stored = 0;
  let duplicates = 0;

  for (let i = 0; i < memories.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;

    const dup = await findDuplicate(embedding);
    if (dup) {
      duplicates++;
      log.debug(
        { newMemory: memories[i], existingId: dup.id },
        "skipping duplicate memory",
      );
      continue;
    }

    const memoryId = await storeMemory({
      content: memories[i] ?? "",
      project_id: projectId,
      type: "fact",
      embedding,
    });
    if (!memoryId) continue;
    stored++;

    const neighbors = await findNeighbors(embedding, memoryId, 5, 0.3);
    for (const neighbor of neighbors) {
      if (!neighbor.id) continue;
      await createRelation(
        memoryId,
        neighbor.id,
        Math.max(0, 1 - neighbor.distance),
      );
    }
  }

  return { stored, duplicates };
}

export async function extractAndStoreMemories(
  messages: ModelMessage[],
  projectId?: string,
  byok: BackgroundByok = null,
) {
  const start = Date.now();

  // Need at least 2 user messages for a meaningful exchange —
  // a greeting + first response isn't worth extracting from
  const userMessages = messages.filter(
    (m) => m.role === "user" && modelContentToString(m.content),
  );
  if (userMessages.length < 2) {
    log.debug(
      { userTurns: userMessages.length },
      "not enough user turns for extraction, skipping",
    );
    return;
  }

  const conversationText = buildExtractionText(messages);
  if (!conversationText || conversationText.length < 200) {
    log.debug(
      { textLength: conversationText?.length ?? 0 },
      "conversation too short for extraction, skipping",
    );
    return;
  }

  log.info(
    {
      userTurns: userMessages.length,
      totalMessages: messages.length,
      extractionTextChars: conversationText.length,
      projectId,
    },
    "starting memory extraction",
  );

  const memories = await extractMemories(conversationText, byok);
  if (memories.length === 0) {
    log.debug("no memories extracted from conversation");
    return;
  }

  log.info({ count: memories.length }, "extracted memories, embedding");
  const { stored, duplicates } = await storeMemoryBatch(memories, projectId);

  log.info(
    {
      stored,
      duplicates,
      total: memories.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "memory extraction complete",
  );
}
