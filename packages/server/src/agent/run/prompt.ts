/**
 * Prompt conversion — ModelMessage[] → LanguageModelV3Prompt.
 *
 * Replaces the AI SDK's convertToLanguageModelPrompt, which is where
 * MissingToolResultsError lived. Same structural conversion without
 * the validation that throws.
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { MimirContext } from "../../middleware/types";
import { safeParseJSON } from "../../util/json";
import { log } from "../../util/logger";

export function buildPrompt(ctx: MimirContext) {
  const messages: ModelMessage[] = [
    { role: "system", content: ctx.systemPrompt },
    ...ctx.contextInjection,
    ...sanitizeToolMessages(ctx.conversationMessages),
  ];
  return messagesToV3Prompt(messages);
}

/**
 * Drop tool-result messages whose toolCallIds have no matching tool-call
 * in a preceding assistant message. This happens when getLastNModelMessages
 * cuts the window between an assistant(tool_calls) and its tool(results),
 * leaving orphan tool results that strict OpenAI-compatible APIs (DeepSeek,
 * etc.) reject with "Messages with role `tool` must be a response to a
 * preceding message with `tool_calls`".
 */
export function sanitizeToolMessages(messages: readonly ModelMessage[]) {
  // Collect all toolCallIds from assistant messages
  const knownCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "tool-call" && part.toolCallId) {
          knownCallIds.add(part.toolCallId);
        }
      }
    }
  }

  const result: ModelMessage[] = [];
  let dropped = 0;
  for (const msg of messages) {
    if (msg.role !== "tool") {
      result.push(msg);
      continue;
    }
    // A tool message is valid only if every tool-result part has a matching
    // tool-call in the known set.
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }
    const toolCallIds = msg.content
      .filter((p) => p.type === "tool-result" && "toolCallId" in p)
      .map((p) => (p as { toolCallId: string }).toolCallId);
    const allResolved =
      toolCallIds.length > 0 &&
      toolCallIds.every((id) => knownCallIds.has(id));
    if (allResolved) {
      result.push(msg);
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    log.warn(
      { dropped, totalMessages: messages.length, kept: result.length },
      "dropped orphan tool-result messages (no matching assistant tool_calls)",
    );
  }

  return result;
}

export function messagesToV3Prompt(messages: ModelMessage[]) {
  const prompt: LanguageModelV3Prompt = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        prompt.push({ role: "system", content: String(msg.content ?? "") });
        break;

      case "user": {
        const content =
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : normalizeUserParts(msg.content);
        prompt.push({ role: "user", content });
        break;
      }

      case "assistant": {
        const content =
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : normalizeAssistantParts(msg.content);
        prompt.push({ role: "assistant", content });
        break;
      }

      case "tool":
        if (Array.isArray(msg.content)) {
          prompt.push({
            role: "tool",
            content: normalizeToolParts(msg.content),
          });
        }
        break;
    }
  }

  return prompt;
}

function normalizeUserParts(parts: unknown) {
  if (!parts || !Array.isArray(parts))
    return [{ type: "text" as const, text: "" }];
  const result: (LanguageModelV3TextPart | LanguageModelV3FilePart)[] = [];
  for (const p of parts) {
    if (p?.type === "file") {
      result.push({
        type: "file" as const,
        data: p.data,
        mediaType: String(
          p.mediaType ?? p.mimeType ?? "application/octet-stream",
        ),
      });
    } else {
      result.push({
        type: "text" as const,
        text: String(p?.text ?? p?.content ?? ""),
      });
    }
  }
  return result;
}

function normalizeAssistantParts(parts: unknown) {
  if (!parts || !Array.isArray(parts))
    return [{ type: "text" as const, text: "" }];
  const result: (
    | LanguageModelV3TextPart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
  )[] = [];
  for (const p of parts) {
    switch (p?.type) {
      case "text":
        result.push({ type: "text" as const, text: String(p.text ?? "") });
        break;
      case "reasoning":
        result.push({ type: "reasoning" as const, text: String(p.text ?? "") });
        break;
      case "tool-call":
        // Critical: ensure input is never undefined and is always an object.
        // Providers (vLLM, Chutes, Fireworks) reject tool calls without arguments
        // or with arguments that decode to a non-object. DB-stored messages have
        // `input` as a JSON string; AI SDK ModelMessages have it as an object.
        result.push({
          type: "tool-call" as const,
          toolCallId: String(p.toolCallId),
          toolName: String(p.toolName),
          input: parseToolInput(p.input),
        });
        break;
      default:
        result.push({
          type: "text" as const,
          text: String(p?.text ?? p?.content ?? ""),
        });
        break;
    }
  }
  return result;
}

/**
 * Coerce tool-call input to an object. DB rows store `input` as a JSON
 * string; AI SDK ModelMessages provide it as a parsed object. Either way,
 * upstream providers require a plain object — not a string, not null.
 */
function parseToolInput(raw: unknown) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  const parsed = safeParseJSON(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function normalizeToolParts(parts: unknown) {
  if (!parts || !Array.isArray(parts)) return [];
  const result: LanguageModelV3ToolResultPart[] = [];
  for (const p of parts) {
    if (p?.type !== "tool-result") continue;
    const output: LanguageModelV3ToolResultPart["output"] =
      p.output && typeof p.output === "object" && "type" in p.output
        ? p.output
        : { type: "text" as const, value: String(p.output ?? "") };
    result.push({
      type: "tool-result" as const,
      toolCallId: String(p.toolCallId),
      toolName: String(p.toolName),
      output,
    });
  }
  return result;
}
