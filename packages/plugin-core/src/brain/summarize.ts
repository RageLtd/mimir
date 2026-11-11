/**
 * Local conversation summarization (MIM-86) — the server compaction
 * summarizer relocated. Produces a type:"summary" replica memory from a
 * conversation window; retrieval injects the summaries nearest the prompt
 * and, on a session's first prompt with none near, the project's newest
 * one, to carry the narrative across sessions.
 *
 * The system prompt is the VERBATIM base prompt from server
 * agent/compaction.ts. Deliberate divergence: the server also had a
 * delta-variant prompt that folded new turns into a running summary —
 * locally each summary is written fresh from the window it is handed (a
 * precompact hands it the whole pre-compaction conversation; over the input
 * cap only an opening slice and the newest messages reach the model, the
 * middle elided), so the base prompt is the honest equivalent.
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
/** Over the cap, the opening of the window keeps this much of the budget —
 *  the opening holds the task statement (or the host's prior compaction
 *  summary) that a newest-only cut would drop. */
export const SUMMARIZE_HEAD_CHARS = 20_000;
/** Stands where the middle of an over-cap window was dropped. */
export const SUMMARIZE_ELISION_LINE = "[… middle of the conversation elided …]";

/**
 * The summary input. Within the cap it is the extraction renderer's output
 * unchanged. Over the cap it keeps an opening slice (up to
 * SUMMARIZE_HEAD_CHARS, cut at a line end when one fits) and the newest
 * messages in the rest of the budget, with the middle elided.
 */
const renderSummaryInput = (messages: readonly ConversationMessage[]) => {
  const full = renderConversation(messages, Number.POSITIVE_INFINITY);
  if (full.length <= SUMMARIZE_MAX_CHARS) {
    return renderConversation(messages, SUMMARIZE_MAX_CHARS);
  }
  const slice = full.slice(0, SUMMARIZE_HEAD_CHARS);
  const lineEnd = slice.lastIndexOf("\n");
  const head = lineEnd > 0 ? slice.slice(0, lineEnd) : slice;
  const budget =
    SUMMARIZE_MAX_CHARS - head.length - SUMMARIZE_ELISION_LINE.length - 2;
  // renderConversation does not count its "\n" joins against maxChars, so
  // its output can run a char per line over; trim the oldest end to fit.
  const newest = renderConversation(messages, budget).slice(-budget);
  return `${head}\n${SUMMARIZE_ELISION_LINE}\n${newest}`;
};

/** Gate → render: a window under the floor skips, otherwise the request. */
export const prepareSummary = (messages: readonly ConversationMessage[]) => {
  const text = renderSummaryInput(messages);
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
 * displace a real one as the project's newest summary.
 */
export const storeSummary = async (opts: {
  readonly replica: OrgReplica;
  readonly embed: EmbedQuery;
  readonly projectId?: string | null;
  readonly text: string;
}) => {
  if (!opts.text.trim()) return null;
  // Embedding is best-effort — an unembedded summary can still be the
  // project's newest summary, and embed-backfill sweeps it up later.
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
 * Summarize a conversation window and store it as a type:"summary" memory.
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
