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
export const formatContentBlocks = (blocks: readonly acp.ContentBlock[]) =>
  acpBlocksToAnthropicContent(blocks)
    .map((part) =>
      part.type === "text" ? part.text : `[Image: ${part.source.media_type}]`,
    )
    .filter(Boolean)
    .join("\n\n");

/**
 * Convert ACP content blocks to Anthropic API message content format.
 *
 * Used when building the SDK prompt input for a multipart user message.
 * Images are preserved as base64 source blocks; everything else is
 * collapsed to text parts, matching formatContentBlocks.
 */
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const VALID_IMAGE_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const isImageMediaType = (s: string): s is ImageMediaType =>
  VALID_IMAGE_TYPES.has(s);

type AnthropicContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ImageMediaType; data: string };
    };

export const acpBlocksToAnthropicContent = (
  blocks: readonly acp.ContentBlock[],
): AnthropicContentPart[] =>
  blocks.flatMap((block): AnthropicContentPart[] => {
    if (block.type === "text") {
      return [{ type: "text" as const, text: block.text }];
    }

    if (block.type === "image") {
      if (!isImageMediaType(block.mimeType)) {
        return [
          {
            type: "text" as const,
            text: `[Unsupported image type: ${block.mimeType}]`,
          },
        ];
      }
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
        {
          type: "text" as const,
          text: `[Resource: ${label}${desc}] (${block.uri})`,
        },
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

/**
 * Build server request metadata for the server-backend path. Prefers the
 * canonical project UUID when available; falls back to the filesystem path
 * until the resolver completes (or when resolution failed entirely).
 */
export const buildMetadata = (
  projectPath: string,
  projectId: string | null,
) => ({
  project: projectId ?? projectPath,
});
