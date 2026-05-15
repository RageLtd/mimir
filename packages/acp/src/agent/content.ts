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

// ── OpenAI multipart content ──

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Convert ACP content blocks to OpenAI multipart content format.
 *
 * Used by the server backend when the user's prompt includes images.
 * Images become `image_url` parts with data-URI encoding; everything
 * else collapses to text parts, matching `acpBlocksToAnthropicContent`.
 */
export const acpBlocksToOpenAIContent = (
  blocks: readonly acp.ContentBlock[],
) =>
  blocks.flatMap((block): OpenAIContentPart[] => {
    if (block.type === "text") {
      return [{ type: "text" as const, text: block.text }];
    }

    if (block.type === "image") {
      return [
        {
          type: "image_url" as const,
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
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

/** True when any block in the array carries image data. */
export const hasImageContent = (blocks: readonly acp.ContentBlock[]) =>
  blocks.some((b) => b.type === "image");

/**
 * Build server request metadata for the server-backend path. Prefers the
 * canonical project UUID when available; falls back to the filesystem path
 * until the resolver completes (or when resolution failed entirely).
 *
 * `userContext` carries the `<user_context>` XML block from the local
 * sqlite store so mimir-server can inject it into the system prompt.
 * The server can't access the client-side profile/memories directly.
 */
export const buildMetadata = (
  projectPath: string,
  projectId: string | null,
  userContext?: string | null,
) => ({
  project: projectId ?? projectPath,
  ...(userContext ? { user_context: userContext } : {}),
});
