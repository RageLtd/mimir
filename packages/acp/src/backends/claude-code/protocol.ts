/**
 * Claude Code stream-json protocol types and NDJSON stream reader.
 *
 * CC emits newline-delimited JSON events on stdout. This module defines
 * the event shapes and provides `iterateNdjson` for consuming them from
 * a ReadableStream, handling chunked delivery and partial lines correctly.
 */

// ── CC stream-json event shapes ──

export type CCInitEvent = {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
};

export type CCAssistantEvent = {
  type: "assistant";
  session_id: string;
  message: {
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        }
    >;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

export type CCToolResultEvent = {
  type: "user";
  session_id: string;
  message: {
    content: Array<
      | {
          type: "tool_result";
          tool_use_id: string;
          content: string | Array<{ type: string; text?: string }>;
        }
      | unknown
    >;
  };
};

export type CCResultEvent = {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type CCEvent =
  | CCInitEvent
  | CCAssistantEvent
  | CCToolResultEvent
  | CCResultEvent
  | { type: "error"; message?: string }
  | { type: string; [key: string]: unknown };

// ── Helpers ──

export const stringifyToolResult = (
  content: CCToolResultEvent["message"]["content"][number],
): string => {
  if (typeof content !== "object" || content === null) return "";
  const c = content as { content?: unknown };
  if (typeof c.content === "string") return c.content;
  if (Array.isArray(c.content)) {
    return c.content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
};

const tryParseJson = (line: string): unknown | undefined => {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

/** Read NDJSON from a ReadableStream<Uint8Array>, yielding parsed objects. */
export const iterateNdjson = async function* (
  stream: ReadableStream<Uint8Array>,
) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const parsed = tryParseJson(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (parsed !== undefined) yield parsed;
        nl = buffer.indexOf("\n");
      }
    }

    const parsed = tryParseJson(buffer);
    if (parsed !== undefined) yield parsed;
  } finally {
    reader.releaseLock();
  }
};
