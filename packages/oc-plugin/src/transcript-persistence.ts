/**
 * Turn distillation — fetch the session transcript from OpenCode's
 * server and extract memories from it into the LOCAL replica (MIM-86).
 * The server persist leg is gone: the transcript never leaves the
 * machine; the org-shared artifact is the extracted memory.
 *
 * OpenCode's message store is the source of truth — no JSONL coalescing
 * needed (unlike the cc-plugin's transcript-delta). The watermark is an
 * in-memory per-session message count: the plugin lives in-process for
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
// The mimir-server's persist endpoint accepts the AI SDK's
// ModelMessage shape. We don't import the type from the AI SDK
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
// The OpenCode SDK is auto-generated; we only touch the fields we
// actually use. Type-checking the return value of `client.session.messages`
// is more brittle than re-declaring the narrow shape we need.

type OpenCodeTextPart = { type: "text"; text?: string };
type OpenCodeToolPart = {
  type: "tool";
  callID?: string;
  name?: string;
  input?: Record<string, unknown>;
};
type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | { type: string };

// Resolved variants — the fields we require are present and string-typed.
// The type guards below narrow to these so downstream reads need no `as`
// cast and no `| undefined` on callID/name/text.
type ResolvedTextPart = { type: "text"; text: string };
type ResolvedToolPart = {
  type: "tool";
  callID: string;
  name: string;
  input?: Record<string, unknown>;
};

const isTextPart = (p: OpenCodePart): p is ResolvedTextPart =>
  p.type === "text" && "text" in p && typeof p.text === "string";

const isToolPart = (p: OpenCodePart): p is ResolvedToolPart =>
  p.type === "tool" &&
  "callID" in p &&
  typeof p.callID === "string" &&
  "name" in p &&
  typeof p.name === "string";

type OpenCodeMessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "tool";
};

type OpenCodeMessage = { info: OpenCodeMessageInfo; parts: OpenCodePart[] };

// ── OpenCode client shape (narrow) ──
//
// We only need `session.messages`. The plugin entry passes the full
// SDK client through; the narrow type here documents what we touch.
// The real SDK wraps every response as `{ data, error } & { request,
// response }`, so `messages` resolves to the wrapped envelope — we unwrap
// `.data` (and surface `.error`) before iterating.

type MessagesResponse = {
  readonly data?: readonly OpenCodeMessage[];
  readonly error?: unknown;
};

type TranscriptClient = {
  readonly session: {
    readonly messages: (args: {
      readonly path: { readonly id: string };
    }) => Promise<MessagesResponse>;
  };
};

type TranscriptLogger = {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
};

/**
 * Convert OpenCode's `{ info, parts }` shape into the AI SDK's
 * ModelMessage. Returns null for messages we don't persist (tool
 * role, empty assistant turns, etc.) — caller filters those out.
 */
export const convertMessage = (msg: OpenCodeMessage) => {
  if (msg.info.role === "user") {
    // User text lives in the message's text parts — NOT in
    // `info.summary.body`, which is the compaction summary and is unset
    // for ordinary turns. Reading summary.body persisted every user turn
    // empty; read the parts, same as the assistant branch.
    const text = msg.parts
      .filter(isTextPart)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length === 0) return null;
    const out: ModelMessage = { role: "user", content: text };
    return out;
  }
  if (msg.info.role === "assistant") {
    const content: AssistantContent[] = [];
    for (const part of msg.parts) {
      if (isTextPart(part)) {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (isToolPart(part)) {
        content.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.name,
          input: part.input ?? {},
        });
      }
      // reasoning, files, step markers, retries, compaction, etc.
      // are auxiliary — skip.
    }
    if (content.length === 0) return null;
    const out: ModelMessage = { role: "assistant", content };
    return out;
  }
  // role === "tool" and any other future roles: auxiliary, skip.
  return null;
};

// Per-session extraction watermark: count of RAW OpenCode messages already
// consumed. Module-level because the plugin is a single in-process instance
// for the session's lifetime. Exported for tests only.
export const _extractionWatermarks = new Map<string, number>();

/**
 * Fetch the session's transcript from OpenCode, take the delta since the
 * last watermark, and distill it into the local replica via the
 * user-configured extraction endpoint. Fire-and-forget: errors are
 * logged but never propagated.
 */
export const persistSessionTranscript = async (
  sessionID: string,
  projectPath: string,
  config: MimirConfig,
  log: TranscriptLogger,
  client: TranscriptClient,
) => {
  const [fetchErr, result] = await attempt(() =>
    client.session.messages({ path: { id: sessionID } }),
  );
  if (fetchErr) {
    log.error("transcript fetch failed", {
      sessionID,
      error: errMessage(fetchErr),
    });
    return;
  }
  if (result.error) {
    log.error("transcript fetch returned error", {
      sessionID,
      error: String(result.error),
    });
    return;
  }
  const messages = result.data ?? [];
  const watermark = _extractionWatermarks.get(sessionID) ?? 0;
  const delta = messages.slice(watermark);

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
    _extractionWatermarks.set(sessionID, messages.length);
    log.debug("session idle — no convertible messages in delta", {
      sessionID,
    });
    return;
  }

  const extraction = await extractionConfig();
  if (!extraction) {
    // No endpoint will ever consume this delta — advance so it can't
    // accumulate forever. Loud once per idle in the log.
    _extractionWatermarks.set(sessionID, messages.length);
    log.warn(
      "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — session not distilled",
      { sessionID, messages: modelMessages.length },
    );
    return;
  }

  const outcome = await extractFromConversation(extraction, modelMessages);
  if (!outcome.ok) {
    log.error("extraction failed — keeping watermark for retry", {
      sessionID,
      messages: modelMessages.length,
      model: extraction.model,
    });
    return;
  }

  if (outcome.skipped) {
    _extractionWatermarks.set(sessionID, messages.length);
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

  _extractionWatermarks.set(sessionID, messages.length);

  log.info("session distilled locally", {
    sessionID,
    project: projectPath,
    projectId,
    watermark,
    newWatermark: messages.length,
    messagesInDelta: modelMessages.length,
    extracted: outcome.memories.length,
    stored,
    duplicates,
    model: extraction.model,
  });
};
