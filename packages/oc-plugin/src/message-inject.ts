/**
 * Model-request helpers for OpenCode V2's session context hook.
 *
 * Extracted from index.ts so the transform logic is unit-testable and the
 * plugin entry stays under the file-length limit.
 */

import { Message } from "@opencode/ai";

export type OcMessage = Message;

/** The most recent user message, or undefined when there is none. */
export const lastUserMessage = (messages: readonly OcMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return m;
  }
  return undefined;
};

/**
 * Concatenate the text-part content of the most recent user message.
 * Used by boot-context assembly to seed the retrieval query.
 */
export const extractLastUserPrompt = (messages: readonly OcMessage[]) => {
  const m = lastUserMessage(messages);
  if (!m) return "";
  const texts: string[] = [];
  for (const part of m.content) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.join("\n");
};

/**
 * Prepend transient context blocks to the recency slot on the
 * last user message, in order. A no-op when there's nothing to inject or no
 * user message to attach to.
 */
export const injectLeadingContext = (
  messages: OcMessage[],
  blocks: readonly string[],
) => {
  if (blocks.length === 0) return;
  const m = lastUserMessage(messages);
  if (!m) return;
  const index = messages.indexOf(m);
  messages[index] = Message.make({
    ...m,
    content: [...blocks.map((text) => Message.text(text)), ...m.content],
  });
};
