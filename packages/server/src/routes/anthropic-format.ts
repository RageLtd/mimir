/**
 * Anthropic Messages API ↔ AI SDK ModelMessage translation.
 *
 * Pure format translation between what Anthropic Messages API clients
 * (Claude Code via subscription redirect) send and what the AI SDK
 * agent loop expects (`ModelMessage`). Mirrors the role of
 * `openai-format.ts` for the `/v1/chat/completions` route.
 *
 * Content blocks handled here:
 *   - text — both user and assistant
 *   - tool_use — assistant only (becomes AI SDK `tool-call` part)
 *   - tool_result — user only (becomes a separate `role: "tool"`
 *     message; any sibling text content turns into a follow-on user
 *     message so the AI SDK's assistant→tool→user ordering invariant
 *     holds)
 *
 * Tool definitions on the request translate from Anthropic's
 * `{ name, description, input_schema }` shape to the OpenAI-style
 * `{ type: "function", function: { name, description, parameters } }`
 * that the middleware pipeline already consumes.
 */

import type { ModelMessage } from "ai";
import type { OpenAIToolDef } from "../middleware/types";

type AnthropicTextBlock = { type: "text"; text: string };

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type AnthropicToolResultContent =
  | string
  | Array<{ type: string; text?: string }>;

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: AnthropicToolResultContent;
  is_error?: boolean;
};

// Strict discriminated union — unknown block types from inbound JSON
// (image, document, thinking, …) fall outside this union and are
// silently dropped at the runtime discriminant checks below.
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
};

type AnthropicSystemBlock = { type: "text"; text: string };

export type AnthropicToolDef = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, unknown>;
  tools?: AnthropicToolDef[];
  tool_choice?: unknown;
};

const flattenTextBlocks = (blocks: AnthropicBlock[]) => {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text.length > 0) {
      out.push(b.text);
    }
  }
  return out.join("\n");
};

const normalizeSystem = (
  system: string | AnthropicSystemBlock[] | undefined,
) => {
  if (!system) return undefined;
  if (typeof system === "string") {
    return system.length > 0 ? system : undefined;
  }
  if (!Array.isArray(system)) return undefined;

  const parts: string[] = [];
  for (const b of system) {
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      parts.push(b.text);
    }
  }
  const joined = parts.join("\n");
  return joined.length > 0 ? joined : undefined;
};

/**
 * Walk every message and build a lookup from `tool_use.id` to the
 * tool's `name`. AI SDK tool-result parts require `toolName`, but
 * Anthropic only supplies `tool_use_id` on results — the name has to
 * come from the matching tool_use earlier in the conversation.
 */
const buildToolCallIdToName = (messages: AnthropicMessage[]) => {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
};

const flattenToolResultContent = (content: AnthropicToolResultContent) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
};

/**
 * Translate one Anthropic assistant message into one AI SDK assistant
 * message. Mixes text and tool-call parts in declaration order so the
 * conversation history reflects "spoke, then called a tool" cadence.
 */
const translateAssistantMessage = (msg: AnthropicMessage) => {
  if (typeof msg.content === "string") {
    const out: ModelMessage = { role: "assistant", content: msg.content };
    return out;
  }

  const parts: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: unknown;
      }
  > = [];

  for (const block of msg.content) {
    if (block.type === "text" && block.text.length > 0) {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      parts.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: block.input ?? {},
      });
    }
  }

  if (parts.length === 0) {
    const out: ModelMessage = { role: "assistant", content: "" };
    return out;
  }

  // Collapse to a string when there's only a single text part — the
  // shape providers prefer for plain text turns.
  if (parts.length === 1 && parts[0]?.type === "text") {
    const out: ModelMessage = { role: "assistant", content: parts[0].text };
    return out;
  }

  const out: ModelMessage = { role: "assistant", content: parts };
  return out;
};

/**
 * Translate one Anthropic user message into one or more AI SDK
 * messages. Tool_result blocks become a separate `role: "tool"`
 * message; any sibling text becomes a follow-on user message so the
 * AI SDK's assistant→tool→user invariant holds.
 */
const translateUserMessage = (
  msg: AnthropicMessage,
  toolCallIdToName: Map<string, string>,
) => {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content } as ModelMessage];
  }

  const toolResults: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
  }> = [];

  for (const block of msg.content) {
    if (block.type !== "tool_result") continue;
    const raw = flattenToolResultContent(block.content);
    const value = block.is_error ? `Error: ${raw}` : raw;
    toolResults.push({
      type: "tool-result",
      toolCallId: block.tool_use_id,
      toolName: toolCallIdToName.get(block.tool_use_id) ?? "unknown",
      output: { type: "text", value },
    });
  }

  const text = flattenTextBlocks(msg.content);
  const out: ModelMessage[] = [];

  if (toolResults.length > 0) {
    out.push({ role: "tool", content: toolResults } as ModelMessage);
  }
  if (text.length > 0) {
    out.push({ role: "user", content: text });
  } else if (toolResults.length === 0) {
    // Empty user content — pass through as empty string so the shape
    // matches the rest of the pipeline.
    out.push({ role: "user", content: "" });
  }

  return out;
};

const translateTools = (tools: AnthropicToolDef[] | undefined) => {
  if (!tools || tools.length === 0) return undefined;
  const out: OpenAIToolDef[] = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
  return out;
};

/**
 * Translate an Anthropic Messages API request body into the shape the
 * AI SDK agent loop consumes (`ModelMessage[]` + a normalised system
 * prompt string + the original model/stream/sampling settings + an
 * OpenAI-shaped `tools` array for the middleware pipeline).
 */
export const normalizeAnthropicRequest = (req: AnthropicRequest) => {
  const toolCallIdToName = buildToolCallIdToName(req.messages);
  const messages: ModelMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role === "user") {
      messages.push(...translateUserMessage(msg, toolCallIdToName));
    } else {
      messages.push(translateAssistantMessage(msg));
    }
  }

  return {
    model: req.model,
    messages,
    systemPrompt: normalizeSystem(req.system),
    stream: req.stream ?? false,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    tools: translateTools(req.tools),
  };
};
