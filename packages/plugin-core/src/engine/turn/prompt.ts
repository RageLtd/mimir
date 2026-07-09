/**
 * Prompt conversion — ModelMessage[] → LanguageModelV3Prompt.
 * Moved from server agent/run/prompt.ts (MIM-89).
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
import { log } from "../log";
import { parseToolInput } from "./json";

/**
 * Normalize tool-call turns before handing history to providers.
 *
 * Two invariants matter here:
 * - Tool results must follow an assistant message with matching tool calls.
 * - All results for one assistant function-call turn must be in a single
 *   tool message. Gemini/GCP rejects split tool-result turns with:
 *   "number of function response parts is equal to the number of function
 *   call parts of the function call turn."
 *
 * If the context window cuts through a tool-call exchange, drop the incomplete
 * block rather than sending a malformed history turn.
 */
export function sanitizeToolMessages(messages: readonly ModelMessage[]) {
  const result: ModelMessage[] = [];
  let droppedToolResults = 0;
  let droppedToolCallTurns = 0;
  let coalescedToolMessages = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === "assistant") {
      const calls = toolCallParts(msg);
      if (calls.length === 0) {
        result.push(msg);
        continue;
      }

      const toolMessages: ModelMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        const toolMessage = messages[j];
        if (toolMessage) toolMessages.push(toolMessage);
        j++;
      }

      const results = toolResultParts(toolMessages);
      const orderedResults = alignResults(calls, results);
      if (!orderedResults) {
        droppedToolCallTurns++;
        droppedToolResults += results.length;
        i = j - 1;
        continue;
      }

      result.push(msg);
      result.push({ role: "tool", content: orderedResults });
      if (toolMessages.length > 1) coalescedToolMessages += toolMessages.length;
      i = j - 1;
      continue;
    }

    if (msg.role === "tool") {
      droppedToolResults += toolResultParts([msg]).length || 1;
      continue;
    }

    result.push(msg);
  }

  if (
    droppedToolResults > 0 ||
    droppedToolCallTurns > 0 ||
    coalescedToolMessages > 0
  ) {
    log.warn("sanitized malformed tool-call history", {
      droppedToolResults,
      droppedToolCallTurns,
      coalescedToolMessages,
      totalMessages: messages.length,
      kept: result.length,
    });
  }

  return result;
}

function toolCallParts(message: ModelMessage) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((part) => part.type === "tool-call");
}

function toolResultParts(messages: readonly ModelMessage[]) {
  const results: Array<ReturnType<typeof toolResultPartsFromMessage>[number]> =
    [];
  for (const message of messages) {
    results.push(...toolResultPartsFromMessage(message));
  }
  return results;
}

function toolResultPartsFromMessage(message: ModelMessage) {
  if (message.role !== "tool" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((part) => part.type === "tool-result");
}

function alignResults(
  calls: ReturnType<typeof toolCallParts>,
  results: ReturnType<typeof toolResultParts>,
) {
  if (calls.length === 0 || calls.length !== results.length) return null;

  const resultsById = new Map<string, (typeof results)[number]>();
  for (const result of results) {
    if (resultsById.has(result.toolCallId)) return null;
    resultsById.set(result.toolCallId, result);
  }

  const orderedResults = [];
  for (const call of calls) {
    const result = resultsById.get(call.toolCallId);
    if (!result) return null;
    orderedResults.push(result);
  }
  return orderedResults;
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
    } else if (p?.type === "image") {
      // ModelMessage image parts (data-URL base64 or URL) — the wire
      // converter (chat.ts normalizeMessages) emits these for user
      // images; providers consume them as file parts.
      result.push({
        type: "file" as const,
        data: p.image,
        mediaType: String(p.mediaType ?? "image/png"),
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
        // Spread source part — carry providerMetadata and any future SDK
        // fields rather than enumerating. Map providerMetadata →
        // providerOptions so Google's thought signatures survive the
        // round-trip (doStream emits providerMetadata; the provider reads
        // providerOptions when formatting outgoing messages).
        result.push({
          ...p,
          type: "tool-call" as const,
          input: parseToolInput(p.input),
          providerOptions: p.providerMetadata ?? p.providerOptions,
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
