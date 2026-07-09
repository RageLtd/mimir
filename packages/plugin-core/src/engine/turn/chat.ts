/**
 * OpenAI chat-completions ↔ AI SDK ModelMessage translation.
 * Moved from server routes/openai-format.ts (MIM-89) — this is the wire
 * shape ACP sessions store in their message log, so the converter now
 * lives beside the engine that consumes it.
 *
 * Key differences handled here:
 * - System messages: OpenAI allows array content; AI SDK requires string
 * - Tool messages: OpenAI uses { role: "tool", tool_call_id, content };
 *   AI SDK expects { role: "tool", content: [{ type: "tool-result", ... }] }
 * - Tool messages without tool_call_id: some clients send bare tool
 *   results — converted to user messages since we can't reconstruct the
 *   required toolCallId/toolName
 */

import type { ImagePart, ModelMessage, TextPart } from "ai";
import { parseToolInput } from "./json";

/** Extract text from either a string or array-of-parts content field. */
const extractTextContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return String(content ?? "");
};

type RawMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
};

/**
 * Convert OpenAI-format chat-completions messages into the AI SDK's
 * `ModelMessage` shape. The mapping is one-to-one for user/assistant text
 * turns; system and tool messages need format adjustments documented at
 * the top of this file.
 */
export const normalizeMessages = (messages: unknown[]) => {
  const rawMessages = messages as RawMessage[];

  // Build a lookup from tool_call_id → toolName by scanning assistant
  // messages. OpenAI format only puts tool_call_id on tool results (no
  // name), so we resolve the name from the preceding assistant message's
  // tool_calls array.
  const toolCallIdToName = new Map<string, string>();
  for (const msg of rawMessages) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName.set(tc.id, tc.function.name);
      }
    }
  }

  const out: ModelMessage[] = rawMessages.map((msg) => {
    // System messages: AI SDK requires string content, not arrays
    if (msg.role === "system") {
      if (Array.isArray(msg.content)) {
        const text = (msg.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        return { role: "system", content: text };
      }
      return { role: "system", content: String(msg.content ?? "") };
    }

    // Tool messages with tool_call_id: proper OpenAI tool result
    if (msg.role === "tool" && msg.tool_call_id) {
      const text = extractTextContent(msg.content);
      const resolvedName = toolCallIdToName.get(msg.tool_call_id) ?? "unknown";
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id,
            toolName: resolvedName,
            output: { type: "text", value: text },
          },
        ],
      } as ModelMessage;
    }

    // Tool messages WITHOUT tool_call_id: can't satisfy ModelMessage
    // schema. Convert to user message to preserve the content without
    // crashing.
    if (msg.role === "tool" && !msg.tool_call_id) {
      const text = extractTextContent(msg.content);
      return { role: "user", content: `[Tool output]: ${text}` };
    }

    // Assistant messages with tool_calls
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const text = extractTextContent(msg.content);
      const parts: Array<{
        type: "text" | "tool-call";
        text?: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
      }> = [];
      if (text) parts.push({ type: "text", text });
      for (const tc of msg.tool_calls) {
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          // Malformed or non-object arguments collapse to {} — providers
          // require a plain object, and a raw string would double-encode.
          input: parseToolInput(tc.function.arguments ?? "{}"),
        });
      }
      return { role: "assistant", content: parts } as ModelMessage;
    }

    // User messages — pass through multipart content (images) when present
    if (msg.role === "user") {
      if (
        Array.isArray(msg.content) &&
        msg.content.some((p: { type?: string }) => p.type === "image_url")
      ) {
        const parts: Array<TextPart | ImagePart> = [];
        for (const p of msg.content as Array<{
          type: string;
          text?: string;
          image_url?: { url: string };
        }>) {
          if (p.type === "text" && p.text) {
            parts.push({ type: "text", text: p.text });
          } else if (p.type === "image_url" && p.image_url?.url) {
            const url = p.image_url.url;
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const [, mediaType, image] = match;
              if (!mediaType || !image) continue;
              parts.push({
                type: "image",
                image,
                mediaType,
              });
            } else {
              parts.push({ type: "image", image: new URL(url) });
            }
          }
        }
        return { role: "user", content: parts } as ModelMessage;
      }
      const text = extractTextContent(msg.content);
      return { role: "user", content: text } as ModelMessage;
    }

    // Assistant messages without tool calls — keep content as-is
    if (msg.role === "assistant") {
      const text = extractTextContent(msg.content);
      return {
        role: msg.role,
        content: text,
      } as ModelMessage;
    }

    // Fallback for unknown roles — coerce to user
    const text = extractTextContent(msg.content);
    return { role: "user", content: text };
  });
  return out;
};
