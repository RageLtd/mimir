import type { ModelMessage } from "@ai-sdk/provider-utils";
import { modelContentToString } from "../agent-loop/message-log/message-utils";
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
function buildQuery(messages: ModelMessage[]): string {
  return messages
    .filter((m) => m.role === "user" && modelContentToString(m.content))
    .slice(-3)
    .map((m) => modelContentToString(m.content) ?? "")
    .join("\n");
}

/**
 * Retrieve relevant memories for the current conversation (global search).
 */
export async function retrieveMemories(
  messages: ModelMessage[],
): Promise<string | null> {
  const start = Date.now();
  const query = buildQuery(messages);
  if (!query) {
    log.debug("no user messages for memory query, skipping retrieval");
    return null;
  }

  log.debug({ queryChars: query.length }, "retrieving memories");

  const queryEmbedding = await embedOne(query);
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
      const finalScore = (combinedScore || 0.5) * freshness;

      return { id: m.id, content: m.content, score: finalScore };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const topMemories = scoredMemories
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .filter((m) => m.score > 0.05);

  if (topMemories.length === 0) {
    log.debug(
      { totalScored: scoredMemories.length },
      "all memories below score threshold",
    );
    return null;
  }

  const topIds = topMemories.map((m) => m.id);
  const related = await getRelatedMemories(topIds, 5);

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

  const result = allMemories.map((m) => `- ${m}`).join("\n");

  log.info(
    {
      topMemories: topMemories.length,
      related: related.length,
      topScores: topMemories
        .slice(0, 3)
        .map((m) => ({ score: m.score.toFixed(4), content: m.content })),
      elapsed: `${Date.now() - start}ms`,
    },
    "memory retrieval complete",
  );

  return result;
}

/**
 * Build extraction text from a conversation.
 * Includes user messages and assistant text responses.
 * Strips tool results (raw data) and tool_call-only assistant messages
 * (just invocation noise).
 */
/** Max chars to send to the extraction model — keeps prompt eval under ~60s on Vulkan */
const EXTRACTION_MAX_CHARS = 4000;

function buildExtractionText(messages: ModelMessage[]): string {
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
 * Project is stored as metadata for display, not for filtering.
 */
export async function storeMemoryBatch(
  memories: string[],
  project?: string,
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
      project, // Stored as metadata for display
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
  project?: string,
): Promise<void> {
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
      project,
    },
    "starting memory extraction",
  );

  const memories = await extractMemories(conversationText);
  if (memories.length === 0) {
    log.debug("no memories extracted from conversation");
    return;
  }

  log.info({ count: memories.length }, "extracted memories, embedding");
  const { stored, duplicates } = await storeMemoryBatch(memories, project);

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
