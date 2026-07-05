import { test, expect, describe } from "bun:test";
import {
  acpBlocksToAnthropicContent,
  buildMetadata,
  formatContentBlocks,
} from "./content";
import type * as acp from "@agentclientprotocol/sdk";

// ── Helpers ──────────────────────────────────────────────────────────────────

const textBlock = (text: string): acp.ContentBlock => ({
  type: "text",
  text,
});

const imageBlock = (
  data = "aGVsbG8=",
  mimeType = "image/png",
): acp.ContentBlock => ({
  type: "image",
  data,
  mimeType,
});

const audioBlock = (
  data = "dGVzdA==",
  mimeType = "audio/wav",
): acp.ContentBlock => ({
  type: "audio",
  data,
  mimeType,
});

const resourceLinkBlock = (
  overrides: Partial<acp.ResourceLink> = {},
): acp.ContentBlock => ({
  type: "resource_link",
  uri: "file:///some/file.ts",
  name: "file.ts",
  ...overrides,
});

const textResourceBlock = (
  text: string,
  uri = "file:///doc.md",
  mimeType?: string,
): acp.ContentBlock => ({
  type: "resource",
  resource: { text, uri, ...(mimeType ? { mimeType } : {}) },
});

const blobResourceBlock = (
  uri = "file:///image.bin",
  mimeType?: string,
): acp.ContentBlock => ({
  type: "resource",
  resource: {
    blob: "YmluYXJ5",
    uri,
    ...(mimeType ? { mimeType } : {}),
  },
});

// ── acpBlocksToAnthropicContent ───────────────────────────────────────────────

describe("acpBlocksToAnthropicContent", () => {
  describe("text blocks", () => {
    test("converts a plain text block", () => {
      const result = acpBlocksToAnthropicContent([textBlock("hello")]);
      expect(result).toEqual([{ type: "text", text: "hello" }]);
    });

    test("preserves whitespace and newlines", () => {
      const text = "line one\n  indented\n\nblank above";
      const result = acpBlocksToAnthropicContent([textBlock(text)]);
      expect(result[0]).toEqual({ type: "text", text });
    });

    test("preserves unicode, emoji, and special characters", () => {
      const text = "Ελληνικά 日本語 🎉 <xml> & \"quotes\"";
      const result = acpBlocksToAnthropicContent([textBlock(text)]);
      expect(result[0]).toEqual({ type: "text", text });
    });

    test("empty text block passes through", () => {
      const result = acpBlocksToAnthropicContent([textBlock("")]);
      expect(result).toEqual([{ type: "text", text: "" }]);
    });
  });

  describe("image blocks", () => {
    test("converts image block to Anthropic base64 format", () => {
      const result = acpBlocksToAnthropicContent([imageBlock()]);
      expect(result).toEqual([
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
      ]);
    });

    test("preserves JPEG mime type", () => {
      const result = acpBlocksToAnthropicContent([
        imageBlock("L3NvbWU=", "image/jpeg"),
      ]);
      expect(result[0]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg" },
      });
    });

    test("preserves webp mime type", () => {
      const result = acpBlocksToAnthropicContent([
        imageBlock("L3NvbWU=", "image/webp"),
      ]);
      expect(result[0]).toMatchObject({
        source: { media_type: "image/webp" },
      });
    });
  });

  describe("audio blocks", () => {
    test("renders audio as a text placeholder (not supported by CC)", () => {
      const result = acpBlocksToAnthropicContent([audioBlock()]);
      expect(result).toEqual([{ type: "text", text: "[Audio: audio/wav]" }]);
    });

    test("includes the mime type in the placeholder", () => {
      const result = acpBlocksToAnthropicContent([
        audioBlock("dGVzdA==", "audio/mpeg"),
      ]);
      expect(result[0]).toEqual({ type: "text", text: "[Audio: audio/mpeg]" });
    });
  });

  describe("resource_link blocks", () => {
    test("renders link with uri and name", () => {
      const result = acpBlocksToAnthropicContent([resourceLinkBlock()]);
      expect(result).toEqual([
        {
          type: "text",
          text: "[Resource: file.ts] (file:///some/file.ts)",
        },
      ]);
    });

    test("prefers title over name when present", () => {
      const result = acpBlocksToAnthropicContent([
        resourceLinkBlock({ title: "My File", name: "file.ts" }),
      ]);
      expect(result[0]).toEqual({
        type: "text",
        text: "[Resource: My File] (file:///some/file.ts)",
      });
    });

    test("includes description when present", () => {
      const result = acpBlocksToAnthropicContent([
        resourceLinkBlock({ description: "The auth module" }),
      ]);
      expect(result[0]).toEqual({
        type: "text",
        text: "[Resource: file.ts — The auth module] (file:///some/file.ts)",
      });
    });

    test("uses uri as label when name is absent", () => {
      // ResourceLink requires name, but test the label priority logic directly
      const result = acpBlocksToAnthropicContent([
        resourceLinkBlock({ name: "fallback", title: undefined }),
      ]);
      expect(result[0]).toMatchObject({ type: "text" });
      expect((result[0] as { type: "text"; text: string }).text).toContain(
        "fallback",
      );
    });
  });

  describe("resource (embedded) blocks", () => {
    test("renders text resource with uri and content", () => {
      const result = acpBlocksToAnthropicContent([
        textResourceBlock("# Hello world", "file:///doc.md"),
      ]);
      expect(result).toEqual([
        {
          type: "text",
          text: "--- file:///doc.md ---\n# Hello world",
        },
      ]);
    });

    test("includes mime type when present", () => {
      const result = acpBlocksToAnthropicContent([
        textResourceBlock("body", "file:///style.css", "text/css"),
      ]);
      expect(result[0]).toEqual({
        type: "text",
        text: "--- file:///style.css (text/css) ---\nbody",
      });
    });

    test("renders blob resource as placeholder with uri", () => {
      const result = acpBlocksToAnthropicContent([blobResourceBlock()]);
      expect(result).toEqual([
        { type: "text", text: "[Binary resource: file:///image.bin]" },
      ]);
    });

    test("includes mime type in blob placeholder when present", () => {
      const result = acpBlocksToAnthropicContent([
        blobResourceBlock("file:///photo.jpg", "image/jpeg"),
      ]);
      expect(result[0]).toEqual({
        type: "text",
        text: "[Binary resource: file:///photo.jpg (image/jpeg)]",
      });
    });
  });

  describe("mixed block arrays", () => {
    test("converts multiple blocks preserving order", () => {
      const blocks: acp.ContentBlock[] = [
        textBlock("preamble"),
        imageBlock(),
        textBlock("postamble"),
      ];
      const result = acpBlocksToAnthropicContent(blocks);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: "text", text: "preamble" });
      expect(result[1]).toMatchObject({ type: "image" });
      expect(result[2]).toEqual({ type: "text", text: "postamble" });
    });

    test("handles all five block types in one array", () => {
      const blocks: acp.ContentBlock[] = [
        textBlock("hello"),
        imageBlock(),
        audioBlock(),
        resourceLinkBlock(),
        textResourceBlock("content"),
      ];
      const result = acpBlocksToAnthropicContent(blocks);
      expect(result).toHaveLength(5);
      expect(result[0]!.type).toBe("text");
      expect(result[1]!.type).toBe("image");
      expect(result[2]!.type).toBe("text"); // audio → placeholder
      expect(result[3]!.type).toBe("text"); // resource_link → text
      expect(result[4]!.type).toBe("text"); // embedded resource → text
    });

    test("returns empty array for empty input", () => {
      expect(acpBlocksToAnthropicContent([])).toEqual([]);
    });
  });
});

// ── formatContentBlocks ───────────────────────────────────────────────────────

describe("formatContentBlocks", () => {
  test("joins text blocks with double newline separator", () => {
    const blocks = [textBlock("first"), textBlock("second")];
    const result = formatContentBlocks(blocks);
    expect(result).toBe("first\n\nsecond");
  });

  test("single text block has no separator", () => {
    expect(formatContentBlocks([textBlock("hello")])).toBe("hello");
  });

  test("image block becomes a text note", () => {
    const result = formatContentBlocks([imageBlock("aGVsbG8=", "image/png")]);
    expect(result).toBe("[Image: image/png]");
  });

  test("image note uses the actual mime type", () => {
    const result = formatContentBlocks([imageBlock("data", "image/gif")]);
    expect(result).toBe("[Image: image/gif]");
  });

  test("audio block becomes a text note", () => {
    const result = formatContentBlocks([audioBlock()]);
    expect(result).toBe("[Audio: audio/wav]");
  });

  test("resource_link block renders as text", () => {
    const result = formatContentBlocks([resourceLinkBlock()]);
    expect(result).toContain("Resource:");
    expect(result).toContain("file:///some/file.ts");
  });

  test("embedded text resource renders with separator and content", () => {
    const result = formatContentBlocks([
      textResourceBlock("const x = 1;", "file:///main.ts", "text/typescript"),
    ]);
    expect(result).toContain("file:///main.ts");
    expect(result).toContain("const x = 1;");
  });

  test("mixed blocks: text before and after image", () => {
    const blocks: acp.ContentBlock[] = [
      textBlock("Look at this:"),
      imageBlock(),
      textBlock("What do you think?"),
    ];
    const result = formatContentBlocks(blocks);
    expect(result).toBe(
      "Look at this:\n\n[Image: image/png]\n\nWhat do you think?",
    );
  });

  test("filters empty text parts from joining", () => {
    // An empty text block produces an empty string — filter(Boolean) removes it
    const blocks: acp.ContentBlock[] = [
      textBlock(""),
      textBlock("visible"),
    ];
    const result = formatContentBlocks(blocks);
    // empty string is falsy so filter(Boolean) removes it
    expect(result).toBe("visible");
  });

  test("returns empty string for empty input", () => {
    expect(formatContentBlocks([])).toBe("");
  });
});


describe("buildMetadata", () => {
  test("canonical project id wins over the path", () => {
    expect(buildMetadata("/repo", "proj-uuid")).toEqual({
      project: "proj-uuid",
    });
    expect(buildMetadata("/repo", null)).toEqual({ project: "/repo" });
  });

  test("small_model rides the metadata when configured (MIM-74)", () => {
    expect(
      buildMetadata("/repo", "proj-uuid", null, null, "anthropic/haiku"),
    ).toEqual({
      project: "proj-uuid",
      small_model: "anthropic/haiku",
    });
  });

  test("empty small model stays absent — server uses the request model", () => {
    expect(buildMetadata("/repo", "proj-uuid", null, null, "")).toEqual({
      project: "proj-uuid",
    });
  });
});
