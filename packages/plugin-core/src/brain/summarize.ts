/**
 * Local conversation summarization (MIM-86) — the server compaction
 * summarizer relocated. Produces a type:"summary" replica memory from a
 * transcript delta; boot-context reads summaries by recency to carry the
 * narrative across sessions.
 *
 * The system prompt is the VERBATIM base prompt from server
 * agent/compaction.ts. Deliberate divergence: the server also had a
 * delta-variant prompt because it re-summarized one growing log — locally
 * every precompact covers a distinct watermark window, so each summary IS
 * a delta by construction and the base prompt is the honest equivalent.
 *
 * Summaries bypass storeTyped's vector dedupe on purpose: consecutive
 * window summaries of one working session can sit close in vector space
 * while being distinct records — dedupe would silently drop history.
 */

import { generateMemoryId, type OrgReplica } from "../store/org-replica";
import {
  type ConversationMessage,
  completeChat,
  type ExtractionConfig,
  renderConversation,
} from "./extract";
import type { EmbedQuery } from "./retrieve";

// ── Verbatim from server agent/compaction.ts ──

const SUMMARIZATION_PROMPT = `You summarize conversations into concise context that preserves all important information for continuing the conversation. Include:
- Key decisions made and their rationale
- Current task state and progress
- Important technical details (file paths, function names, architecture choices)
- Any unresolved questions or pending work
- User preferences and constraints mentioned

Output a clear, dense summary in 2-4 paragraphs. Do not include pleasantries or meta-commentary.`;

const SUMMARIZATION_MAX_TOKENS = 8192;
const SUMMARIZATION_TIMEOUT_MS = 120_000;
/** Server compaction's input cap, carried over. */
const SUMMARIZE_MAX_CHARS = 120_000;
/** A window smaller than this isn't worth a summary record. */
const MIN_SUMMARY_INPUT_CHARS = 400;

/**
 * Summarize a delta window and store it as a type:"summary" memory.
 * Outcome mirrors extractFromConversation: skips are success (advance
 * the watermark), ok:false is transport failure (retry next time).
 */
export const summarizeToReplica = async (opts: {
  readonly config: ExtractionConfig;
  readonly replica: OrgReplica;
  readonly messages: readonly ConversationMessage[];
  readonly embed: EmbedQuery;
  readonly projectId?: string | null;
}) => {
  const text = renderConversation(opts.messages, SUMMARIZE_MAX_CHARS);
  if (text.length < MIN_SUMMARY_INPUT_CHARS) {
    return { ok: true as const, id: null, skipped: "window too small" };
  }

  const summary = await completeChat(opts.config, {
    system: SUMMARIZATION_PROMPT,
    user: text,
    maxTokens: SUMMARIZATION_MAX_TOKENS,
    timeoutMs: SUMMARIZATION_TIMEOUT_MS,
  });
  if (summary === null) {
    return { ok: false as const, id: null, skipped: null };
  }

  // Embedding is best-effort — an unembedded summary still serves the
  // recency-ordered boot read, and embed-backfill sweeps it up later.
  const embedding = await opts.embed(summary);
  const id = generateMemoryId();
  opts.replica.upsertMemory({
    id,
    content: summary,
    type: "summary",
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    ...(embedding ? { embedding } : {}),
  });

  return { ok: true as const, id, skipped: null };
};
