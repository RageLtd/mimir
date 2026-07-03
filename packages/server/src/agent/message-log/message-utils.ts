/**
 * Shared utilities for working with ai-sdk ModelMessage types.
 *
 * The api/types.ts `contentToString` handles OpenAI format at the API boundary.
 * This module handles ai-sdk ModelMessage content — the internal format used
 * everywhere else in the agent loop.
 */

import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
  UserContent,
} from "@ai-sdk/provider-utils";

// ---------------------------------------------------------------------------
// Content-to-string extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from ModelMessage content.
 * Strings pass through, arrays extract TextPart.text values, null/undefined → "".
 */
export function modelContentToString(
  content:
    | string
    | UserContent
    | AssistantContent
    | ToolContent
    | null
    | undefined,
) {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          p.type === "text" && !!p.text,
      )
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Message identity + trailing-turn verification
// ---------------------------------------------------------------------------

/**
 * Fingerprint a message for dedup matching.
 * Uses role + content hash. Stable across serialization round-trips.
 */
export function fingerprintMessage(msg: ModelMessage) {
  const content =
    typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content ?? "");
  return `${msg.role}:${Bun.hash(content).toString(36)}`;
}

// ---------------------------------------------------------------------------
// DB serialization — store ModelMessage directly
// ---------------------------------------------------------------------------

/** Row shape stored in SurrealDB */
export interface MessageRow {
  id: string;
  project: string;
  /** Optional canonical project UUID. Populated by Slice-2-aware writers; old rows omit it. */
  project_id?: string | null;
  role: string;
  /** JSON-serialized content — either a JSON string or a JSON array of content parts */
  content: string;
  /** Explicit ordering within the conversation — preserves client array position */
  seq: number;
  created_at: string;
}

/**
 * Serialize a ModelMessage for DB storage.
 * Content is always JSON — either a JSON string or a JSON array of content parts.
 *
 * `projectId` is the optional canonical UUID. When omitted (server-internal
 * writes from appendTrailingTurn / appendAssistantOutput that have no
 * resolver context) the column is left null and reads still see the row.
 */
export function modelMessageToFields(
  msg: ModelMessage,
  project: string,
  seq?: number,
  projectId?: string | null,
) {
  const fields: Record<string, unknown> = {
    project,
    role: msg.role,
    content: JSON.stringify(msg.content),
  };
  if (seq !== undefined) {
    fields.seq = seq;
  }
  if (projectId) {
    fields.project_id = projectId;
  }
  return fields;
}

/**
 * Deserialize a DB row back to a ModelMessage.
 * Content stored as JSON.
 */
export function rowToModelMessage(row: MessageRow) {
  const role = row.role as ModelMessage["role"];
  const content =
    typeof row.content === "string" ? JSON.parse(row.content) : row.content;
  return { role, content } as ModelMessage;
}
