/**
 * Content block formatting and prompt assembly.
 *
 * Converts ACP ContentBlock arrays into plain text for model consumption,
 * and assembles the CC context wrapper for the claude-code backend.
 */

import type * as acp from "@agentclientprotocol/sdk";

/** Convert ACP content blocks into a single text string for the model. */
export const formatContentBlocks = (
  blocks: readonly acp.ContentBlock[],
): string =>
  blocks
    .map((block) => {
      if (block.type === "text") return block.text;

      if (block.type === "resource_link") {
        // Zed sends resource_links for @-mentioned files, diagnostics, symbols.
        // Include the URI so the model can reference/open the file.
        const label = block.title ?? block.name ?? block.uri;
        const desc = block.description ? ` — ${block.description}` : "";
        return `[Resource: ${label}${desc}] (${block.uri})`;
      }

      if (block.type === "resource") {
        // Embedded context — Zed sends full file contents or diagnostic
        // text when embeddedContext capability is advertised.
        const resource = block.resource;
        if ("text" in resource) {
          const uri = resource.uri ?? "";
          const mime = resource.mimeType ?? "";
          // If it looks like a file, wrap it so the model sees the path
          if (uri) {
            return `--- ${uri}${mime ? ` (${mime})` : ""} ---\n${resource.text}`;
          }
          return resource.text;
        }
        // Blob resources (images, binary) — note their existence
        return `[Binary resource: ${resource.uri ?? "unknown"}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`;
      }

      if (block.type === "image") {
        // Image blocks carry base64 data; note for context but don't dump bytes
        return `[Image: ${block.mimeType}${block.uri ? `, ${block.uri}` : ""}]`;
      }

      if (block.type === "audio") {
        return `[Audio: ${block.mimeType}]`;
      }

      return "";
    })
    .join("\n\n");

/** Build server request metadata from user profile and project path. */
export const buildMetadata = (
  userProfile: string | null,
  projectPath: string,
): Record<string, unknown> => ({
  project: projectPath,
  ...(userProfile ? { userProfile } : {}),
});

/**
 * Assemble the wrapped prompt for the CC backend.
 *
 * Injects session context (summaries, memories, user profile) around the
 * user message. On --resume follow-ups the caller skips this and sends
 * the raw prompt text instead.
 */
export const buildCCPrompt = (
  userMessage: string,
  summaries: readonly { content: string; created_at: string }[],
  memories: string | null,
  userProfile: string | null,
): string => {
  const parts: string[] = ["<session_context>"];

  if (summaries.length > 0) {
    parts.push("<summaries>");
    summaries.forEach((s, i) => {
      parts.push(`[Summary ${i + 1} — ${s.created_at}]\n${s.content}`);
    });
    parts.push("</summaries>");
  }

  if (memories) {
    parts.push("<memories>");
    parts.push(memories);
    parts.push("</memories>");
  }

  if (userProfile) {
    parts.push("<user_profile>");
    parts.push(userProfile);
    parts.push("</user_profile>");
  }

  parts.push("</session_context>");
  parts.push("");
  parts.push("<user_message>");
  parts.push(userMessage);
  parts.push("</user_message>");

  return parts.join("\n");
};
