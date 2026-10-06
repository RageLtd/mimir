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
 * success OR deliberate skip (extraction gates), keep on transport
 * failure so the next idle retries the same delta. Unconfigured
 * extraction advances too — otherwise the delta grows forever toward
 * an endpoint that will never exist.
 *
 * Errors are logged but never block the session going idle.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
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

/**
 * Fetch the session's transcript from OpenCode, take the delta since the
 * last watermark, and distill it into the local replica via the
 * user-configured extraction endpoint. Fire-and-forget: errors are
 * logged but never propagated.
 */
const persistTranscript = async (
  sessionID: string,
  projectPath: string,
  config: MimirConfig,
  log: TranscriptLogger,
  client: TranscriptClient,
  ops: typeof extractionOperations,
) => {
  const [fetchErr, messages] = await attempt(() =>
    client.session.context({ sessionID }),
  );
  if (fetchErr) {
    log.error("transcript fetch failed", {
      sessionID,
      error: errMessage(fetchErr),
    });
    return;
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
    return;
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
    return;
  }

  const extraction = await ops.extractionConfig();
  if (!extraction) {
    // No endpoint will ever consume this delta — advance so it can't
    // accumulate forever. Loud once per idle in the log.
    advance();
    log.warn(
      "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — session not distilled",
      { sessionID, messages: modelMessages.length },
    );
    return;
  }

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
    advance();
    log.debug("extraction skipped", { sessionID, reason: outcome.skipped });
    return;
  }

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
  const embedQuery = createEmbedQuery();

  let stored = 0;
  let duplicates = 0;
  for (const memory of outcome.memories) {
    const [storeErr, storeResult] = await attempt(() =>
      storeTyped(replica, embedQuery, {
        content: memory,
        type: "fact",
        ...(projectId ? { project: projectId } : {}),
      }),
    );
    if (storeErr) {
      log.warn("memory store failed", { error: storeErr.message });
      continue;
    }
    if (storeResult.stored) stored++;
    else duplicates++;
  }
  replica.close();

  advance();

  log.info("session distilled locally", {
    sessionID,
    project: projectPath,
    projectId,
    watermark,
    newWatermark,
    messagesInDelta: modelMessages.length,
    extracted: outcome.memories.length,
    stored,
    duplicates,
    model: extraction.model,
  });
};

/** Idle and precompaction share a queue so neither extracts the same delta concurrently. */
export const persistSessionTranscript = (
  sessionID: string,
  projectPath: string,
  config: MimirConfig,
  log: TranscriptLogger,
  client: TranscriptClient,
  ops: typeof extractionOperations = extractionOperations,
) => {
  const pending = (pendingPersistence.get(sessionID) ?? Promise.resolve())
    .then(() =>
      persistTranscript(sessionID, projectPath, config, log, client, ops),
    )
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
