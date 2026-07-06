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
  /** Owning org id — the tenant boundary (MIM-69). */
  org_id: string;
  /** Canonical project ULID (id portion of the project table record). */
  project_id: string;
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
 * `orgId` is the tenant boundary; `projectId` is the canonical project ULID —
 * callers resolve whatever identifier the client sent (path or id) at the API
 * boundary before it reaches this layer.
 */
export function modelMessageToFields(
  msg: ModelMessage,
  orgId: string,
  projectId: string,
  seq?: number,
) {
  const fields: Record<string, unknown> = {
    org_id: orgId,
    project_id: projectId,
    role: msg.role,
    content: JSON.stringify(msg.content),
  };
  if (seq !== undefined) {
    fields.seq = seq;
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
