/**
 * Content block formatting and prompt assembly.
 *
 * Converts ACP ContentBlock arrays into plain text for model consumption,
 * and assembles the CC context wrapper for the claude-code backend.
 */

import type * as acp from "@agentclientprotocol/sdk";

/**
 * Convert ACP content blocks into a single text string for the model.
 *
 * Derives from acpBlocksToAnthropicContent — text parts are joined as-is,
 * image parts produce a textual note (since this path is text-only).
 */
export const formatContentBlocks = (
  blocks: readonly acp.ContentBlock[],
): string =>
  acpBlocksToAnthropicContent(blocks)
    .map((part) =>
      part.type === "text"
        ? part.text
        : `[Image: ${part.source.media_type}]`,
    )
    .filter(Boolean)
    .join("\n\n");

/** True when any block in the array is an image. */
export const hasImageBlocks = (blocks: readonly acp.ContentBlock[]) =>
  blocks.some((b) => b.type === "image");

/**
 * Convert ACP content blocks to Anthropic API message content format.
 *
 * Used when piping a multipart user message to the CC subprocess via stdin
 * (--input-format stream-json). Images are preserved as base64 source blocks;
 * everything else is collapsed to text parts, matching formatContentBlocks.
 */
type AnthropicContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export const acpBlocksToAnthropicContent = (
  blocks: readonly acp.ContentBlock[],
): AnthropicContentPart[] =>
  blocks.flatMap((block): AnthropicContentPart[] => {
    if (block.type === "text") {
      return [{ type: "text" as const, text: block.text }];
    }

    if (block.type === "image") {
      return [
        {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: block.mimeType,
            data: block.data,
          },
        },
      ];
    }

    if (block.type === "resource_link") {
      const label = block.title ?? block.name ?? block.uri;
      const desc = block.description ? ` — ${block.description}` : "";
      return [
        { type: "text" as const, text: `[Resource: ${label}${desc}] (${block.uri})` },
      ];
    }

    if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource) {
        const mime = resource.mimeType ?? "";
        return [
          {
            type: "text" as const,
            text: `--- ${resource.uri}${mime ? ` (${mime})` : ""} ---\n${resource.text}`,
          },
        ];
      }
      // BlobResourceContents — binary data; render a placeholder
      return [
        {
          type: "text" as const,
          text: `[Binary resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`,
        },
      ];
    }

    if (block.type === "audio") {
      return [{ type: "text" as const, text: `[Audio: ${block.mimeType}]` }];
    }

    return [];
  });

/** Build server request metadata from project path. */
export const buildMetadata = (
  projectPath: string,
): Record<string, unknown> => ({
  project: projectPath,
});

