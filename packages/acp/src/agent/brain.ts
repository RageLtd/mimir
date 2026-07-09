/**
 * Post-turn brain work for the local agent (MIM-89 slice D).
 *
 * Extraction: after each completed turn, the new-message window (per-
 * session in-memory watermark, oc-plugin pattern — a process restart
 * re-extracts once and storeTyped's vector dedupe absorbs it) is
 * distilled into the local replica on the user-chosen extraction model.
 * Watermark semantics mirror the cc/oc plugins: advance on success OR
 * deliberate skip OR unconfigured extraction; keep only on transport
 * failure so the next turn retries the same delta.
 *
 * Compaction (the real one — ACP owns its message log): when the turn's
 * reported prompt tokens cross the threshold share of the model's context
 * window, the older window is summarized into a type:"summary" replica
 * memory and session.messages is trimmed to the recent tail. No summary
 * banked → no trim: a transport failure must never destroy history.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { summarizeToReplica } from "@mimir/plugin-core/brain/summarize";
import { attempt } from "@mimir/plugin-core/result";
import type { OrgReplica } from "@mimir/plugin-core/store/org-replica";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { extractionConfig } from "../config";
import { createChildLogger, log } from "../utils/log";
import type { SessionState } from "./types";

const logger = createChildLogger(log, "brain");

/** Compaction fires when promptTokens exceeds this share of the window. */
const COMPACTION_THRESHOLD = 0.8;
/**
 * Messages kept verbatim after a compaction trim. The summary carries the
 * older narrative; the tail keeps the working context concrete. Snapped
 * forward to a user-message boundary so an assistant tool_calls turn is
 * never split from its tool results.
 */
const KEEP_RECENT_MESSAGES = 8;

// One llama-server client per process — createEmbedQuery get-or-starts
// the embedder on first use.
let _embedQuery: ReturnType<typeof createEmbedQuery> | null = null;
export const sharedEmbedQuery = () => {
  _embedQuery ??= createEmbedQuery();
  return _embedQuery;
};

/** Per-session extraction watermark: count of session.messages already
 *  distilled. Exported for tests only. */
export const _extractionWatermarks = new Map<string, number>();

/**
 * Distill the new-message window into the replica. ChatMessage satisfies
 * the brain's structural ConversationMessage ({role: string, content:
 * unknown}) — no adapter needed.
 */
export const distillSession = async (
  session: SessionState,
  replica: OrgReplica,
) => {
  const watermark = _extractionWatermarks.get(session.sessionId) ?? 0;
  // Capture the delta end NOW — the array can grow while extraction runs,
  // and those messages belong to the next window.
  const deltaEnd = session.messages.length;
  const delta = session.messages.slice(watermark, deltaEnd);
  if (delta.length === 0) return;

  const extraction = extractionConfig();
  if (!extraction) {
    _extractionWatermarks.set(session.sessionId, deltaEnd);
    logger.warn(
      "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL) — turn not distilled",
      { sessionId: session.sessionId, messages: delta.length },
    );
    return;
  }

  const outcome = await extractFromConversation(extraction, delta);
  if (!outcome.ok) {
    logger.error("extraction failed — keeping watermark for retry", {
      sessionId: session.sessionId,
      model: extraction.model,
    });
    return;
  }
  if (outcome.skipped) {
    _extractionWatermarks.set(session.sessionId, deltaEnd);
    logger.debug("extraction skipped", { reason: outcome.skipped });
    return;
  }

  const embedQuery = sharedEmbedQuery();
  let stored = 0;
  let duplicates = 0;
  for (const memory of outcome.memories) {
    const [storeErr, result] = await attempt(() =>
      storeTyped(replica, embedQuery, {
        content: memory,
        type: "fact",
        ...(session.projectId ? { project: session.projectId } : {}),
      }),
    );
    if (storeErr) {
      logger.warn("memory store failed:", storeErr.message);
      continue;
    }
    if (result.stored) stored++;
    else duplicates++;
  }
  _extractionWatermarks.set(session.sessionId, deltaEnd);

  logger.info("turn distilled locally", {
    sessionId: session.sessionId,
    extracted: outcome.memories.length,
    stored,
    duplicates,
    model: extraction.model,
  });
};

/**
 * Summarize-and-trim when the turn's prompt usage crossed the threshold.
 * `persist` is the caller's write-through to sessions.db, invoked only
 * when the trim actually happened.
 */
export const maybeCompact = async (opts: {
  readonly session: SessionState;
  readonly replica: OrgReplica;
  readonly promptTokens?: number;
  readonly contextWindow?: number;
  readonly persist: () => void;
}) => {
  const { session, replica, promptTokens, contextWindow, persist } = opts;
  if (!promptTokens || !contextWindow || contextWindow <= 0) return;
  if (promptTokens < COMPACTION_THRESHOLD * contextWindow) return;

  const extraction = extractionConfig();
  if (!extraction) {
    logger.warn(
      "context past compaction threshold but extraction unconfigured — cannot summarize",
      { promptTokens, contextWindow },
    );
    return;
  }

  if (session.messages.length <= KEEP_RECENT_MESSAGES) return;
  // Snap the cut forward to a user message so tool sequences stay whole.
  let cut = session.messages.length - KEEP_RECENT_MESSAGES;
  while (
    cut < session.messages.length &&
    session.messages[cut]?.role !== "user"
  ) {
    cut++;
  }
  if (cut <= 0 || cut >= session.messages.length) return;

  const window = session.messages.slice(0, cut);
  const outcome = await summarizeToReplica({
    config: extraction,
    replica,
    messages: window,
    embed: sharedEmbedQuery(),
    projectId: session.projectId,
  });
  if (!outcome.ok) {
    logger.error("compaction summarize failed — history NOT trimmed", {
      sessionId: session.sessionId,
      model: extraction.model,
    });
    return;
  }

  // Trim against the CURRENT array — messages appended while the
  // summary ran sit beyond the cut and survive. Re-anchor the extraction
  // watermark to the shifted indices.
  session.messages = session.messages.slice(cut);
  const watermark = _extractionWatermarks.get(session.sessionId) ?? 0;
  _extractionWatermarks.set(session.sessionId, Math.max(0, watermark - cut));
  persist();

  logger.info("session compacted", {
    sessionId: session.sessionId,
    summarized: cut,
    kept: session.messages.length,
    summaryId: outcome.id,
    skipped: outcome.skipped,
  });
};

/** Reset a session's extraction watermark — callers that wipe
 *  session.messages (the /compact command) must re-anchor to zero. */
export const resetWatermark = (sessionId: string) => {
  _extractionWatermarks.set(sessionId, 0);
};

/**
 * `/compact` upgrade (MIM-89): bank the session into the replica —
 * best-effort distillation of the un-extracted tail, then a full-window
 * summary — BEFORE the caller wipes the log. Returns whether a summary
 * record was actually stored; false (unconfigured or transport failure)
 * still lets the caller wipe — /compact is an explicit user request.
 */
export const bankSessionBeforeReset = async (
  session: SessionState,
  replica: OrgReplica,
) => {
  const extraction = extractionConfig();
  if (!extraction) {
    logger.warn("/compact without extraction config — nothing banked");
    return false;
  }
  await distillSession(session, replica);
  const outcome = await summarizeToReplica({
    config: extraction,
    replica,
    messages: session.messages,
    embed: sharedEmbedQuery(),
    projectId: session.projectId,
  });
  if (!outcome.ok) {
    logger.error("/compact summarize failed — wiping without a summary", {
      sessionId: session.sessionId,
    });
    return false;
  }
  return outcome.id !== null;
};

/**
 * The whole post-turn sequence — extraction FIRST (it consumes the
 * pre-trim indices), then compaction. Called fire-and-forget from
 * core.prompt so the editor's end_turn isn't held hostage to a slow
 * extraction model; failures log and retry on later turns.
 */
export const postTurnBrainWork = async (opts: {
  readonly session: SessionState;
  readonly replica: OrgReplica;
  readonly promptTokens?: number;
  readonly contextWindow?: number;
  readonly persist: () => void;
}) => {
  await distillSession(opts.session, opts.replica);
  await maybeCompact(opts);
};
