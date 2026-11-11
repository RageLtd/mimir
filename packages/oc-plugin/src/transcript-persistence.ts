/**
 * Turn distillation — fetch the session transcript from OpenCode's
 * server and extract memories from it into the LOCAL replica (MIM-86).
 * The server persist leg is gone: the transcript never leaves the
 * machine; the org-shared artifact is the extracted memory.
 *
 * OpenCode's message store is the source of truth — no JSONL coalescing
 * needed (unlike the cc-plugin's transcript-delta). The watermark is an
 * in-memory per-session last processed message ID: the plugin lives in-process for
 * the whole session, so it survives across `session.idle` fires. A
 * process restart re-extracts the conversation once; storeTyped's
 * vector dedupe absorbs the repeats.
 *
 * Watermark semantics mirror the cc-plugin persist hook: advance on
 * success; keep on transport failure so the next idle retries the same
 * delta, and on a gate skip so the next idle carries it (one turn alone
 * rarely passes the two-user-turn gate). Unconfigured extraction
 * advances — otherwise the delta grows forever toward an endpoint that
 * will never exist.
 *
 * Compaction summarises the whole window, not the delta, and reads facts
 * from the delta alone; a second in-memory map records the last message
 * a stored summary covered, so an unchanged window is summarised once.
 *
 * Errors are logged but never block the session going idle.
 */

import {
  compactionOwed,
  settleCompaction,
} from "@mimir/plugin-core/brain/compaction-plan";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { summarizeToReplica } from "@mimir/plugin-core/brain/summarize";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { syncAfterDistill } from "@mimir/plugin-core/sync/after-distill";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { errMessage } from "@mimir/plugin-core/util";
import { extractionConfig, type MimirConfig } from "./config";
import {
  convertMessage,
  convertMessages,
  type TranscriptClient,
  type TranscriptLogger,
} from "./transcript-convert";

export {
  convertMessage,
  type TranscriptClient,
  type TranscriptLogger,
} from "./transcript-convert";

// Stable record IDs survive appends; a checkpoint missing after compaction
// restarts extraction at the beginning of the replacement context.
export const _extractionWatermarks = new Map<string, string>();
// The last record a stored compaction summary covered, per session.
export const _summaryWatermarks = new Map<string, string>();
const pendingPersistence = new Map<string, Promise<void>>();
const extractionOperations = { extractionConfig, extractFromConversation };
const closingOperations = {
  ...extractionOperations,
  summarizeToReplica,
  syncAfterDistill,
};

type Run = {
  readonly sessionID: string;
  readonly projectPath: string;
  readonly config: MimirConfig;
  readonly log: TranscriptLogger;
  readonly client: TranscriptClient;
};

/**
 * The session's records, how far the extraction watermark has read them,
 * and how to move it past the last one. Null when the fetch failed.
 */
const readSession = async ({ sessionID, log, client }: Run) => {
  const [fetchErr, records] = await attempt(() =>
    client.session.context({ sessionID }),
  );
  if (fetchErr) {
    log.error("transcript fetch failed", {
      sessionID,
      error: errMessage(fetchErr),
    });
    return null;
  }
  const watermark = _extractionWatermarks.get(sessionID);
  const checkpoint = records.findIndex((record) => record.id === watermark);
  const newWatermark = records.at(-1)?.id;
  const advance = () => {
    if (newWatermark) _extractionWatermarks.set(sessionID, newWatermark);
  };
  return {
    records,
    delta: records.slice(checkpoint + 1),
    watermark,
    newWatermark,
    advance,
  };
};

/**
 * The session's messages since the watermark, converted, and how to move
 * the watermark past them. Null when there is nothing to distil: the
 * fetch failed, nothing is new, or nothing new is convertible.
 */
const readDelta = async (run: Run) => {
  const { sessionID, log } = run;
  const session = await readSession(run);
  if (!session) return null;
  const { delta, watermark, newWatermark, advance } = session;

  if (delta.length === 0) {
    log.debug("session idle — no new messages since watermark", {
      sessionID,
      watermark,
    });
    return null;
  }

  const modelMessages = convertMessages(delta);

  if (modelMessages.length === 0) {
    // Nothing convertible — advance past the noise so it isn't rescanned.
    advance();
    log.debug("session idle — no convertible messages in delta", {
      sessionID,
    });
    return null;
  }

  return { modelMessages, watermark, newWatermark, advance };
};

/**
 * The configured endpoint, or null after advancing past messages no
 * endpoint will ever consume — otherwise they accumulate forever. Loud
 * once per run in the log.
 */
const endpointOrAdvance = async (
  { sessionID, log }: Run,
  ops: typeof extractionOperations,
  advance: () => void,
  sizes: Record<string, number>,
) => {
  const extraction = await ops.extractionConfig();
  if (extraction) return extraction;
  advance();
  log.warn(
    "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — session not distilled",
    { sessionID, ...sizes },
  );
  return null;
};

/** The replica, embedder and project attribution every store path needs. */
const openStore = async ({ sessionID, projectPath, config, log }: Run) => {
  // Project id for memory attribution — disk-cached after first resolution.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
    config.apiKey,
  ).catch((err) => {
    log.warn("project id resolve failed", {
      sessionID,
      error: errMessage(err),
    });
    return null;
  });
  const replica = createOrgReplica(
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
  );
  return { projectId, replica, embedQuery: createEmbedQuery() };
};

const storeFacts = async (
  store: Awaited<ReturnType<typeof openStore>>,
  memories: readonly string[],
  log: TranscriptLogger,
) => {
  let stored = 0;
  let duplicates = 0;
  for (const memory of memories) {
    const [storeErr, storeResult] = await attempt(() =>
      storeTyped(store.replica, store.embedQuery, {
        content: memory,
        type: "fact",
        ...(store.projectId ? { project: store.projectId } : {}),
      }),
    );
    if (storeErr) {
      log.warn("memory store failed", { error: storeErr.message });
      continue;
    }
    if (storeResult.stored) stored++;
    else duplicates++;
  }
  return { stored, duplicates };
};

/**
 * Idle: distil the delta's facts into the local replica via the
 * user-configured extraction endpoint. Errors are logged, never thrown.
 */
const persistTranscript = async (
  run: Run,
  ops: typeof extractionOperations,
) => {
  const { sessionID, projectPath, log } = run;
  const delta = await readDelta(run);
  if (!delta) return;
  const { modelMessages, watermark, newWatermark, advance } = delta;
  const extraction = await endpointOrAdvance(run, ops, advance, {
    messages: modelMessages.length,
  });
  if (!extraction) return;

  const outcome = await ops.extractFromConversation(extraction, modelMessages);
  if (!outcome.ok) {
    log.error("extraction failed — keeping watermark for retry", {
      sessionID,
      messages: modelMessages.length,
      model: extraction.model,
    });
    return;
  }

  if (outcome.skipped) {
    // Too little to distil yet. An idle usually follows one user message,
    // so advancing here would drop every ordinary turn: the next idle
    // carries it.
    log.debug("extraction skipped — the next idle carries this delta", {
      sessionID,
      reason: outcome.skipped,
    });
    return;
  }

  const store = await openStore(run);
  const { stored, duplicates } = await storeFacts(store, outcome.memories, log);
  store.replica.close();

  advance();

  log.info("session distilled locally", {
    sessionID,
    project: projectPath,
    projectId: store.projectId,
    watermark,
    newWatermark,
    messagesInDelta: modelMessages.length,
    extracted: outcome.memories.length,
    stored,
    duplicates,
    model: extraction.model,
  });
};

/**
 * Compaction: the window is about to be replaced, so this is its last
 * reading. A type:"summary" memory of the whole window first (the
 * narrative record boot context reads by recency) unless the window is
 * unchanged since the last stored summary, then the delta's facts
 * without waiting for a second user turn, then a sync of whatever landed.
 *
 * A failed summary keeps the watermark and reads no facts. That is not a
 * retry: the next window starts after this compaction's boundary, so the
 * failed window is never summarised again, and its delta's facts are not
 * read either: the replacement context no longer holds those messages,
 * so later extraction starts after the boundary. Otherwise the
 * watermark moves; a failed fact
 * extraction only logs, because retrying would store a near-identical
 * summary again, which is worse than losing one window's facts.
 */
const distillWindow = async (run: Run, ops: typeof closingOperations) => {
  const { sessionID, projectPath, log } = run;
  const session = await readSession(run);
  if (!session) return;
  const { advance } = session;
  const window = convertMessages(session.records);
  const delta = convertMessages(session.delta);
  // The summary mark keys on the window's last message, not its last
  // record: auxiliary records appended since do not make it look grown.
  const lastMessageId = session.records.findLast(
    (record) => convertMessage(record) !== null,
  )?.id;
  const summarise =
    lastMessageId !== undefined &&
    _summaryWatermarks.get(sessionID) !== lastMessageId;
  // The summariser gates on the floor itself, so it is still called
  // whenever `summarise` is set; the owed check is only so a window that
  // cannot clear the floor, with no delta, resolves no endpoint and opens
  // no store.
  const owed = compactionOwed({ window, delta, summaryDue: summarise });
  const caughtUp = owed.summary === null && owed.facts === null;
  const sizes = {
    messagesInWindow: window.length,
    messagesInDelta: delta.length,
  };

  if (caughtUp) {
    advance();
    log.debug("precompact: window summarised and delta distilled already", {
      sessionID,
      ...sizes,
    });
    return;
  }
  const extraction = await endpointOrAdvance(run, ops, advance, sizes);
  if (!extraction) return;

  const store = await openStore(run);
  const summary = summarise
    ? await ops.summarizeToReplica({
        config: extraction,
        replica: store.replica,
        messages: window,
        embed: store.embedQuery,
        projectId: store.projectId,
      })
    : null;
  // Kept in step with settleCompaction: a failed summary reads no facts.
  const outcome =
    delta.length > 0 && (!summary || summary.ok)
      ? await ops.extractFromConversation(extraction, delta, { closing: true })
      : null;
  const facts =
    outcome?.ok && !outcome.skipped
      ? await storeFacts(store, outcome.memories, log)
      : { stored: 0, duplicates: 0 };
  if (outcome && !outcome.ok) {
    log.warn("precompact: fact extraction failed (summary unaffected)", {
      sessionID,
    });
  }
  store.replica.close();

  const settled = settleCompaction({ summary, factsStored: facts.stored });
  if (!settled.advance) {
    log.error("precompact: summarization failed — keeping watermark", {
      sessionID,
      ...sizes,
      model: extraction.model,
    });
    return;
  }

  advance();
  const summaryId = summary?.id ?? null;
  if (settled.markSummarized && lastMessageId !== undefined) {
    _summaryWatermarks.set(sessionID, lastMessageId);
  }

  log.info("precompact: window distilled locally", {
    sessionID,
    project: projectPath,
    projectId: store.projectId,
    ...sizes,
    summaryId,
    summarySkipped: summary?.skipped ?? null,
    factsStored: facts.stored,
    model: extraction.model,
  });

  if (settled.sync) await ops.syncAfterDistill(log);
};

/** Idle and precompaction share a queue so neither distils the same delta concurrently. */
const enqueue = (run: Run, distil: () => Promise<void>) => {
  const { sessionID, log } = run;
  const pending = (pendingPersistence.get(sessionID) ?? Promise.resolve())
    .then(distil)
    .catch((err) =>
      log.error("transcript persist failed", {
        sessionID,
        error: errMessage(err),
      }),
    );
  pendingPersistence.set(sessionID, pending);
  void pending.then(() => {
    if (pendingPersistence.get(sessionID) === pending)
      pendingPersistence.delete(sessionID);
  });
  return pending;
};

export const persistSessionTranscript = (
  sessionID: string,
  projectPath: string,
  config: MimirConfig,
  log: TranscriptLogger,
  client: TranscriptClient,
  ops: typeof extractionOperations = extractionOperations,
) => {
  const run = { sessionID, projectPath, config, log, client };
  return enqueue(run, () => persistTranscript(run, ops));
};

export const distillBeforeCompaction = (
  sessionID: string,
  projectPath: string,
  config: MimirConfig,
  log: TranscriptLogger,
  client: TranscriptClient,
  ops: typeof closingOperations = closingOperations,
) => {
  const run = { sessionID, projectPath, config, log, client };
  return enqueue(run, () => distillWindow(run, ops));
};
