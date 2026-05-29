/**
 * Global append-only message log — the single-brain conversation store.
 *
 * There is one continuous conversation across all clients, all projects,
 * all time. The DB is the source of truth. Clients are UI shells over the
 * same brain.
 *
 * Write side:
 *   - `appendTrailingTurn`  — server backend path. Extracts the trailing
 *                             user/tool block from a client's request and
 *                             appends it (with retry idempotency).
 *   - `appendAssistantOutput` — server owns its own writes. Called at the
 *                               end of an LLM turn in the server backend.
 *   - `appendTurn`          — CC persist endpoint. CC tracks its delta
 *                             client-side; server just appends with retry
 *                             idempotency.
 *
 * Read side:
 *   - `getLastNModelMessages(N)` is the canonical read for context
 *     assembly. Summaries sit alongside — never in place of — raw
 *     messages in the prompt.
 *
 * Implementation notes:
 *   - Array-based record ID: `message_log:[project, timestamp_ns]`
 *   - `project` is metadata for display; reads are unscoped (global)
 *   - Token-based compaction triggers are handled in compaction-state.ts
 *
 * TODO: TTL cleanup for old messages. The log grows unbounded today;
 * a maintenance job can prune entries older than the oldest active
 * summary once the log reaches tens of thousands of entries.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { getDb, queryOne } from "../../db/surreal";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import {
  type MessageRow,
  modelMessageToFields,
  rowToModelMessage,
} from "./message-utils";

// ---------------------------------------------------------------------------
// Message Log Operations
// ---------------------------------------------------------------------------

/**
 * Append a message to the global log.
 * Uses array-based record ID for efficient time-range queries.
 *
 * Note: Uses Bun.nanoseconds() for timestamp to prevent collisions
 * when multiple messages arrive within the same millisecond.
 */
export async function appendModelMessage(
  message: ModelMessage,
  project: string,
  projectId?: string | null,
) {
  const start = Date.now();
  const db = await getDb();

  // Use nanoseconds to prevent collisions when multiple messages
  // arrive within the same millisecond (e.g., user message + tool result)
  const timestamp = Bun.nanoseconds();
  const recordId = `[${JSON.stringify(project)}, ${timestamp}]`;

  const fields = modelMessageToFields(message, project, undefined, projectId);
  fields.id = recordId;

  const [err, result] = await attempt(() =>
    db.query<[MessageRow[]]>(
      `CREATE type::record('message_log', $id) CONTENT $fields`,
      { id: recordId, fields },
    ),
  );

  if (err) {
    log.error(
      { err, project, projectId, role: message.role },
      "failed to append message",
    );
    return null;
  }

  const created = result?.[0]?.[0];
  if (!created?.id) {
    log.error(
      { project, projectId, role: message.role },
      "message append returned no ID",
    );
    return null;
  }

  log.debug(
    {
      id: created.id,
      project,
      projectId,
      role: message.role,
      elapsed: `${Date.now() - start}ms`,
    },
    "appended message to log",
  );

  return created.id;
}

/**
 * Fingerprint a message for dedup matching.
 * Uses role + content hash. Stable across serialization round-trips.
 */
function fingerprint(msg: ModelMessage) {
  const content =
    typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content ?? "");
  return `${msg.role}:${Bun.hash(content).toString(36)}`;
}

/**
 * Extract the trailing `user` / `tool` block from a client's request.
 *
 * Under the single-brain model, the client contributes only its trailing new
 * input each turn — either a user message or one-or-more tool-result messages
 * following a server-emitted assistant tool_call. Everything earlier in the
 * client's `messages` array is informational context the server already
 * knows about (or can ignore — the DB is source of truth).
 *
 * Walks from the end, collecting consecutive `user` or `tool` messages.
 * Stops as soon as an assistant message appears (those are server outputs,
 * already persisted when they streamed).
 */
export function extractTrailingTurn(clientMessages: readonly ModelMessage[]) {
  const trailing: ModelMessage[] = [];
  for (let i = clientMessages.length - 1; i >= 0; i--) {
    const msg = clientMessages[i];
    if (!msg) break;
    if (msg.role === "user" || msg.role === "tool") {
      trailing.unshift(msg);
    } else {
      break;
    }
  }
  return trailing;
}

/**
 * Append a client's trailing turn to the global log.
 *
 * Server-owned single-brain write path:
 *   - Walks the client's request from the end, collecting the trailing
 *     contiguous user/tool block (see `extractTrailingTurn`).
 *   - Idempotency: if the DB's tail already matches the trailing block by
 *     role+content hash, the request is a retry — skip the append.
 *   - Otherwise append each message in order using `appendModelMessage`.
 *
 * Returns the ids of appended messages (empty array for no-op / retry).
 *
 * This REPLACES `appendNewMessages` for the `/v1/chat/completions` path.
 * The CC-backend persist endpoint still uses `appendNewMessages` because it
 * ships whole conversations including assistant outputs the server never
 * saw.
 */
export async function appendTrailingTurn(
  clientMessages: readonly ModelMessage[],
  project: string,
) {
  const trailing = extractTrailingTurn(clientMessages);
  if (trailing.length === 0) {
    log.debug(
      { clientCount: clientMessages.length },
      "appendTrailingTurn: no trailing user/tool block",
    );
    return [];
  }

  // Idempotency: check if the DB tail already matches the trailing block.
  // Fetch the last N messages (same length as the trailing block) and
  // compare fingerprints in order. If identical, skip — this is a retry.
  const dbTail = await getLastModelMessages(trailing.length);
  if (dbTail.length === trailing.length) {
    const dbFps = dbTail.map(fingerprint);
    const trailingFps = trailing.map(fingerprint);
    const allMatch = dbFps.every((fp, idx) => fp === trailingFps[idx]);
    if (allMatch) {
      log.debug(
        { count: trailing.length },
        "appendTrailingTurn: trailing block matches DB tail, skipping (retry)",
      );
      return [];
    }
  }

  const appendedIds: (string | null)[] = [];
  for (const message of trailing) {
    const id = await appendModelMessage(message, project);
    appendedIds.push(id ?? null);
  }

  log.info(
    {
      project,
      appended: appendedIds.length,
      roles: trailing.map((m) => m.role),
    },
    "appendTrailingTurn complete",
  );
  return appendedIds;
}

/**
 * Append a single assistant output to the global log.
 *
 * Called at the end of an LLM turn in the server backend path — the server
 * owns its own writes. Persists the assistant text plus any tool_call parts
 * as one `role: "assistant"` entry. On cancel / error mid-stream, callers
 * should NOT invoke this; the user's input remains in the log unanswered
 * and the next request will append cleanly after it.
 */
export async function appendAssistantOutput(
  message: ModelMessage,
  project: string,
) {
  if (message.role !== "assistant") {
    log.warn(
      { role: message.role },
      "appendAssistantOutput called with non-assistant message",
    );
    return null;
  }
  const id = await appendModelMessage(message, project);
  log.info({ project, id }, "appendAssistantOutput: assistant turn persisted");
  return id;
}

/**
 * Append a known turn delta to the global log.
 *
 * Used by the CC persist endpoint (`/v1/messages/persist`): the CC backend
 * runs inference locally via the Claude Agent SDK, tracks its own message
 * history, and ships the last-N of that history per turn. The delta is
 * already chosen client-side — the server just appends it.
 *
 * Retry idempotency: if the DB's tail already matches the incoming delta
 * by role+content hash, skip the append. Handles duplicate POSTs and CC
 * reconnect-replay scenarios.
 *
 * Unlike `appendTrailingTurn`, this helper does NOT filter by role —
 * assistant messages from CC's own inference are a legitimate part of the
 * delta and must be persisted (mimir-server never saw them emitted).
 */
export async function appendTurn(
  messages: readonly ModelMessage[],
  project: string,
  projectId?: string | null,
) {
  if (messages.length === 0) return [];

  // Retry idempotency — compare the incoming delta against the DB tail.
  const dbTail = await getLastModelMessages(messages.length);
  if (dbTail.length === messages.length) {
    const dbFps = dbTail.map(fingerprint);
    const msgFps = messages.map(fingerprint);
    const allMatch = dbFps.every((fp, idx) => fp === msgFps[idx]);
    if (allMatch) {
      log.debug(
        { count: messages.length, project, projectId },
        "appendTurn: delta matches DB tail, skipping (retry)",
      );
      return [];
    }
  }

  const appendedIds: (string | null)[] = [];
  for (const message of messages) {
    const id = await appendModelMessage(message, project, projectId);
    appendedIds.push(id ?? null);
  }

  log.info(
    {
      appended: appendedIds.length,
      project,
      projectId,
      roles: messages.map((m) => m.role),
    },
    "appendTurn complete",
  );
  return appendedIds;
}

/**
 * Get messages since a specific timestamp from the global log.
 * Used by the async compaction path to gather the tail since the last
 * summary for summarization. Not used on the read path — context
 * assembly uses `getLastNModelMessages`.
 */
export async function getModelMessagesSince(
  since: Date,
): Promise<ModelMessage[]> {
  const start = Date.now();

  // Use > not >= to exclude messages created at the same instant as the summary
  // Those messages were already compacted into that summary
  const [err, entries] = await attempt(() =>
    queryOne<MessageRow>(
      `SELECT * FROM message_log WHERE created_at > $since ORDER BY created_at ASC`,
      { since: since.toISOString() },
    ),
  );

  if (err) {
    log.error(
      { err, since: since.toISOString() },
      "failed to get messages since",
    );
    return [];
  }

  const messages = entries.map(rowToModelMessage);

  log.debug(
    {
      since: since.toISOString(),
      count: messages.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "retrieved messages since timestamp",
  );

  return messages;
}

/**
 * Get the last N messages from the global log, in chronological order.
 *
 * This is the canonical read for context assembly under the single-brain
 * model: always return the last N raw messages regardless of summary
 * state. Summaries sit alongside these messages in the prompt, never in
 * place of them.
 */
export async function getLastNModelMessages(count: number) {
  return getLastModelMessages(count);
}

/**
 * Get the last N messages from the global log, in chronological order.
 * Used for sequence-based anchor matching in appendNewMessages.
 */
export async function getLastModelMessages(
  count: number,
): Promise<ModelMessage[]> {
  const [err, entries] = await attempt(() =>
    queryOne<MessageRow>(
      `SELECT * FROM message_log ORDER BY created_at DESC LIMIT $count`,
      { count },
    ),
  );

  if (err) {
    log.error({ err, count }, "failed to get last N messages");
    return [];
  }

  // Reverse to chronological order (oldest first)
  return entries.reverse().map(rowToModelMessage);
}
