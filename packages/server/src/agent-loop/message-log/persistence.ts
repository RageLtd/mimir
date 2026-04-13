/**
 * Phase 6: Single Brain Architecture
 *
 * Global append-only message log. One continuous log for all projects,
 * with project as metadata for context scoping.
 *
 * Key design:
 * - Array-based record ID: message_log:[project, timestamp]
 * - Efficient time-range queries for context assembly
 * - Token-based compaction triggers
 * - Async summarization (no request latency impact)
 *
 * Global scope:
 * - Message log queries are global (no project filter)
 * - Memory search is global (cross-project knowledge transfer)
 * - Compaction state is singular (one global log to compact)
 * - Project field is metadata for display, not a filter
 *
 * TODO: TTL cleanup for old messages. The message_log table grows unbounded.
 * A scheduled job should delete messages older than the earliest summary's
 * last_message_id. Deferred until heartbeat/maintenance task infrastructure
 * is in place.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { getDb, queryFirst, queryOne } from "../../db/surreal";
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
) {
  const start = Date.now();
  const db = await getDb();

  // Use nanoseconds to prevent collisions when multiple messages
  // arrive within the same millisecond (e.g., user message + tool result)
  const timestamp = Bun.nanoseconds();
  const recordId = `[${JSON.stringify(project)}, ${timestamp}]`;

  const fields = modelMessageToFields(message, project);
  fields.id = recordId;

  const [err, result] = await attempt(() =>
    db.query<[MessageRow[]]>(
      `CREATE type::record('message_log', $id) CONTENT $fields`,
      { id: recordId, fields },
    ),
  );

  if (err) {
    log.error({ err, project, role: message.role }, "failed to append message");
    return "";
  }

  const created = result?.[0]?.[0];
  if (!created?.id) {
    log.error({ project, role: message.role }, "message append returned no ID");
    return "";
  }

  log.debug(
    {
      id: created.id,
      project,
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
 * Append only truly new messages from the client.
 *
 * The client sends the full conversation history every time. We find where
 * new messages begin by matching the last few persisted messages (as a
 * sequence) against the client array.
 *
 * Sequence matching (not single-message) prevents false anchors from
 * duplicate content (e.g. reading the same file twice). A sequence of 3
 * consecutive fingerprints is astronomically unlikely to repeat.
 *
 * This approach works across clients (each client only sends its own
 * history, DB may have messages from other clients) and doesn't break
 * when server tool steps are present in the DB.
 */
export async function appendNewMessages(
  clientMessages: ModelMessage[],
  project: string,
) {
  if (clientMessages.length === 0) {
    return [];
  }

  // Get the last few messages from the DB for sequence matching.
  // We use 3 messages as a sequence anchor — enough to avoid false
  // matches from duplicate content, cheap enough to query.
  const ANCHOR_SIZE = 3;
  const dbRecent = await getLastModelMessages(ANCHOR_SIZE);

  let startIndex = 0;

  if (dbRecent.length > 0) {
    // Build fingerprints for the DB anchor sequence
    const dbFingerprints = dbRecent.map(fingerprint);

    // Scan the client array backwards looking for the anchor sequence.
    // We're looking for the LAST occurrence to handle any duplicates.
    const clientFingerprints = clientMessages.map(fingerprint);

    for (
      let i = clientFingerprints.length - dbFingerprints.length;
      i >= 0;
      i--
    ) {
      const slice = clientFingerprints.slice(i, i + dbFingerprints.length);
      if (slice.every((fp, idx) => fp === dbFingerprints[idx])) {
        startIndex = i + dbFingerprints.length;
        break;
      }
    }

    // If no sequence match found, try matching just the last DB message
    // (handles cases where DB has fewer messages than ANCHOR_SIZE)
    if (startIndex === 0 && dbFingerprints.length > 0) {
      const lastFp = dbFingerprints[dbFingerprints.length - 1];
      for (let i = clientFingerprints.length - 1; i >= 0; i--) {
        if (clientFingerprints[i] === lastFp) {
          startIndex = i + 1;
          break;
        }
      }
    }
  }

  const newMessages = clientMessages.slice(startIndex);

  if (newMessages.length === 0) {
    log.debug(
      { clientCount: clientMessages.length, dbCount: dbRecent.length },
      "appendNewMessages: no new messages",
    );
    return [];
  }

  log.debug(
    {
      clientCount: clientMessages.length,
      startIndex,
      appending: newMessages.length,
      roles: newMessages.map((m) => m.role),
    },
    "appendNewMessages: appending new messages",
  );

  const appendedIds = [];
  for (const message of newMessages) {
    const id = await appendModelMessage(message, project);
    appendedIds.push(id ?? null);
  }

  log.info(
    { appended: appendedIds.length, project },
    "appendNewMessages complete",
  );
  return appendedIds;
}

/**
 * Get recent messages from the global log, ordered by timestamp.
 * Used for context assembly when no summaries exist yet.
 */
export async function getRecentModelMessages(
  limit?: number,
): Promise<ModelMessage[]> {
  const start = Date.now();

  const query = limit
    ? `SELECT * FROM message_log ORDER BY created_at DESC LIMIT $limit`
    : `SELECT * FROM message_log ORDER BY created_at DESC`;

  const [err, entries] = await attempt(() =>
    queryOne<MessageRow>(query, limit ? { limit } : undefined),
  );

  if (err) {
    log.error({ err, limit }, "failed to get recent messages");
    return [];
  }

  // Reverse to get chronological order (oldest first)
  const messages = entries.reverse().map(rowToModelMessage);

  log.debug(
    {
      count: messages.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "retrieved recent messages",
  );

  return messages;
}

/**
 * Get messages since a specific timestamp from the global log.
 * Used for context assembly after the last summary.
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
 * Get the last message from the global log.
 * Used to determine the starting point for new messages.
 */
export async function getLastModelMessage(): Promise<ModelMessage | null> {
  const entry = await queryFirst<MessageRow>(
    `SELECT * FROM message_log ORDER BY created_at DESC LIMIT 1`,
  );
  return entry ? rowToModelMessage(entry) : null;
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
