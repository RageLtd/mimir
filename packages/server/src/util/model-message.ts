/**
 * Shared utilities for working with ai-sdk ModelMessage content.
 *
 * The api/types.ts `contentToString` handles OpenAI format at the API boundary.
 * This module handles ai-sdk ModelMessage content — the internal format used
 * everywhere else in the agent loop.
 */

import type {
  AssistantContent,
  ToolContent,
  UserContent,
} from "@ai-sdk/provider-utils";

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
