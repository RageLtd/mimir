/**
 * Types for the mimir-server context API.
 *
 * These define the contract for the endpoints mimir-acp expects
 * from mimir-server. The server's internal types (store.ts Memory,
 * context-assembly.ts AssembledContext) are the source of truth;
 * these are the API-facing shapes.
 */

/** A retrieved memory from Goldfish */
export interface Memory {
  id: string;
  content: string;
  project?: string;
  type: "fact" | "summary";
  created_at?: string;
  last_accessed?: string;
  confidence?: number;
  access_count?: number;
}

/** A compaction summary */
export interface CompactionSummary {
  content: string;
  token_count?: number;
  created_at: string;
}

/** Response from GET /v1/context */
export interface ContextResponse {
  /** Relevant memories for the current query */
  memories: Memory[];
  /** Recent compaction summaries */
  summaries: CompactionSummary[];
  /** Project rules text (from CLAUDE.md, .cursorrules, etc.) */
  rules: string | null;
  /** Cartographer index status if available */
  indexStatus: string | null;
}

/** A single message for persistence */
export interface PersistMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** Request body for POST /v1/persist */
export interface PersistRequest {
  /** Session identifier */
  sessionId: string;
  /** Project path for memory scoping */
  project?: string;
  /** Messages to persist and extract memories from */
  messages: PersistMessage[];
}
