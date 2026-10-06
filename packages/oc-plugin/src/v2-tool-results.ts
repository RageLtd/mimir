import type { Result } from "@opencode/plugin/promise/tool";

/** Tool-hook input is an untrusted protocol boundary. */
export const toolInput = (input: unknown) =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

export const toolText = (result: Result) => {
  if (typeof result.content === "string") return result.content;
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
};

/** Preserve files, structured output and metadata when adding model-visible prose. */
export const appendToolText = (result: Result, text: string) =>
  ({
    ...result,
    content:
      typeof result.content === "string"
        ? result.content + text
        : [...(result.content ?? []), { type: "text", text }],
  }) satisfies Result;
