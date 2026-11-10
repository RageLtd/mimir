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
 * Errors are logged but never block the session going idle.
 */

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

// ── ModelMessage shape ──
//
// Local extraction accepts the AI SDK's ModelMessage shape.
// We don't import the type from the AI SDK
// directly — the type is purely structural and the import would
// pull @ai-sdk/provider-utils into the published bundle. Defining
// it locally keeps the bundle small and the contract obvious.

type AssistantContent =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantContent[] };

// ── OpenCode SDK types (narrow) ──
//
// V2 context records are readonly discriminated records, not V1
// { info, parts } envelopes. Only the fields extraction consumes live here.

type OpenCodePart =
  | { readonly type: "text" | "reasoning"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly state: {
        readonly input: Readonly<Record<string, unknown>> | string;
      };
    };

type OpenCodeMessage =
  | { readonly id: string; readonly type: "user"; readonly text: string }
  | {
      readonly id: string;
      readonly type: "assistant";
      readonly content: readonly OpenCodePart[];
    }
  | { readonly id: string; readonly type: string };

// ── OpenCode client shape (narrow) ──
//
// The plugin entry passes ctx directly. V2 returns records directly and
// rejects failed requests, with no data/error response wrapper.

export type TranscriptClient = {
  readonly session: {
    readonly context: (args: {
      readonly sessionID: string;
    }) => Promise<readonly OpenCodeMessage[]>;
  };
};

export type TranscriptLogger = {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
};

/**
 * Convert OpenCode's V2 context record into the AI SDK's
 * ModelMessage. Returns null for auxiliary records and empty turns.
 */
export const convertMessage = (msg: OpenCodeMessage) => {
  if (msg.type === "user" && "text" in msg) {
    const text = msg.text.trim();
    if (text.length === 0) return null;
    const out: ModelMessage = { role: "user", content: text };
    return out;
  }
  if (msg.type === "assistant" && "content" in msg) {
    const content: AssistantContent[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "tool" && typeof part.state.input !== "string") {
        content.push({
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          input: { ...part.state.input },
        });
      }
      // reasoning, files, step markers, retries, compaction, etc.
      // are auxiliary — skip.
    }
    if (content.length === 0) return null;
    const out: ModelMessage = { role: "assistant", content };
    return out;
  }
  // Compaction, idle, system updates, etc. are auxiliary; skip.
  return null;
};

// Stable record IDs survive appends; a checkpoint missing after compaction
// restarts extraction at the beginning of the replacement context.
export const _extractionWatermarks = new Map<string, string>();
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
 * The session's messages since the watermark, converted, and how to move
 * the watermark past them. Null when there is nothing to distil: the
 * fetch failed, nothing is new, or nothing new is convertible.
 */
const readDelta = async ({ sessionID, log, client }: Run) => {
  const [fetchErr, messages] = await attempt(() =>
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
  const checkpoint = messages.findIndex((message) => message.id === watermark);
  const delta = messages.slice(checkpoint + 1);
  const newWatermark = messages.at(-1)?.id;
  const advance = () => {
    if (newWatermark) _extractionWatermarks.set(sessionID, newWatermark);
  };

  if (delta.length === 0) {
    log.debug("session idle — no new messages since watermark", {
      sessionID,
      watermark,
    });
    return null;
  }

  const modelMessages: ModelMessage[] = [];
  for (const msg of delta) {
    const converted = convertMessage(msg);
    if (converted) modelMessages.push(converted);
  }

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
 * The configured endpoint, or null after advancing past a delta no
 * endpoint will ever consume — otherwise it accumulates forever. Loud
 * once per run in the log.
 */
const endpointOrAdvance = async (
  { sessionID, log }: Run,
  ops: typeof extractionOperations,
  delta: NonNullable<Awaited<ReturnType<typeof readDelta>>>,
) => {
  const extraction = await ops.extractionConfig();
  if (extraction) return extraction;
  delta.advance();
  log.warn(
    "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — session not distilled",
    { sessionID, messages: delta.modelMessages.length },
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
  const extraction = await endpointOrAdvance(run, ops, delta);
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
 * reading. A type:"summary" memory first (the narrative record boot
 * context reads by recency), then its facts without waiting for a second
 * user turn, then a sync of whatever landed.
 *
 * The watermark moves once the summary is settled; a failed fact
 * extraction only logs, because retrying would store a near-identical
 * summary again, which is worse than losing one window's facts.
 */
const distillWindow = async (run: Run, ops: typeof closingOperations) => {
  const { sessionID, projectPath, log } = run;
  const delta = await readDelta(run);
  if (!delta) return;
  const { modelMessages, advance } = delta;
  const extraction = await endpointOrAdvance(run, ops, delta);
  if (!extraction) return;

  const store = await openStore(run);
  const summary = await ops.summarizeToReplica({
    config: extraction,
    replica: store.replica,
    messages: modelMessages,
    embed: store.embedQuery,
    projectId: store.projectId,
  });
  if (!summary.ok) {
    store.replica.close();
    log.error("precompact: summarization failed — keeping watermark", {
      sessionID,
      messages: modelMessages.length,
      model: extraction.model,
    });
    return;
  }

  const outcome = await ops.extractFromConversation(extraction, modelMessages, {
    closing: true,
  });
  const facts =
    outcome.ok && !outcome.skipped
      ? await storeFacts(store, outcome.memories, log)
      : { stored: 0, duplicates: 0 };
  if (!outcome.ok) {
    log.warn("precompact: fact extraction failed (summary still stored)", {
      sessionID,
    });
  }
  store.replica.close();

  advance();

  log.info("precompact: window distilled locally", {
    sessionID,
    project: projectPath,
    projectId: store.projectId,
    messagesInDelta: modelMessages.length,
    summaryId: summary.id,
    summarySkipped: summary.skipped,
    factsStored: facts.stored,
    model: extraction.model,
  });

  if (summary.id !== null || facts.stored > 0) await ops.syncAfterDistill(log);
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
