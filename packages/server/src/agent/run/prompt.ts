/**
 * Prompt conversion — ModelMessage[] → LanguageModelV3Prompt.
 *
 * Replaces the AI SDK's convertToLanguageModelPrompt, which is where
 * MissingToolResultsError lived. Same structural conversion without
 * the validation that throws.
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { MimirContext } from "../../middleware/types";

export function buildPrompt(ctx: MimirContext) {
  const messages: ModelMessage[] = [
    { role: "system", content: ctx.systemPrompt },
    ...ctx.contextInjection,
    ...ctx.conversationMessages,
  ];
  return messagesToV3Prompt(messages);
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
        // Critical: ensure input is never undefined.
        // Providers (vLLM, Chutes) reject tool calls without arguments.
        result.push({
          type: "tool-call" as const,
          toolCallId: String(p.toolCallId),
          toolName: String(p.toolName),
          input: p.input ?? {},
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
