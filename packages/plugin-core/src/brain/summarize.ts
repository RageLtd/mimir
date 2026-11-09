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
  completeRequest,
  type ExtractionConfig,
  renderConversation,
  requestLeg,
  skipLeg,
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

/** Gate → render: a window under the floor skips, otherwise the request. */
export const prepareSummary = (messages: readonly ConversationMessage[]) => {
  const text = renderConversation(messages, SUMMARIZE_MAX_CHARS);
  if (text.length < MIN_SUMMARY_INPUT_CHARS) {
    return skipLeg("window too small");
  }
  return requestLeg({
    system: SUMMARIZATION_PROMPT,
    prompt: text,
    maxTokens: SUMMARIZATION_MAX_TOKENS,
  });
};

/**
 * Store a finished summary as a type:"summary" memory; returns its id.
 * Blank text stores nothing and returns null — an empty summary row would
 * displace a real one in the recency-ordered boot read.
 */
export const storeSummary = async (opts: {
  readonly replica: OrgReplica;
  readonly embed: EmbedQuery;
  readonly projectId?: string | null;
  readonly text: string;
}) => {
  if (!opts.text.trim()) return null;
  // Embedding is best-effort — an unembedded summary still serves the
  // recency-ordered boot read, and embed-backfill sweeps it up later.
  const embedding = await opts.embed(opts.text);
  const id = generateMemoryId();
  opts.replica.upsertMemory({
    id,
    content: opts.text,
    type: "summary",
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    ...(embedding ? { embedding } : {}),
  });
  return id;
};

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
  const prepared = prepareSummary(opts.messages);
  if ("skipped" in prepared) {
    return { ok: true as const, id: null, skipped: prepared.skipped };
  }

  const summary = await completeRequest(
    opts.config,
    prepared.request,
    SUMMARIZATION_TIMEOUT_MS,
  );
  if (summary === null) {
    return { ok: false as const, id: null, skipped: null };
  }

  const id = await storeSummary({
    replica: opts.replica,
    embed: opts.embed,
    projectId: opts.projectId,
    text: summary,
  });
  return { ok: true as const, id, skipped: null };
};
