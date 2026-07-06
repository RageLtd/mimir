/**
 * Message-shape helpers for OpenCode's `experimental.chat.messages.transform`.
 *
 * OpenCode operates on `{ info: Message; parts: Part[] }` — NOT the
 * `{ role, content }` shape. User and assistant text live in the message's
 * text parts, and context injections occupy the recency slot by prepending a
 * synthetic text part to the last user message rather than pushing a whole
 * synthetic message at index 0.
 *
 * Extracted from index.ts so the transform logic is unit-testable and the
 * plugin entry stays under the file-length limit.
 */

import type { Message, Part } from "@opencode-ai/sdk";

export type OcMessage = { info: Message; parts: Part[] };

/** The most recent user message, or undefined when there is none. */
export const lastUserMessage = (messages: readonly OcMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info.role === "user") return m;
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
  for (const part of m.parts) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.join("\n");
};

/**
 * Prepend context blocks to the recency slot as synthetic text parts on the
 * last user message, in order. A no-op when there's nothing to inject or no
 * user message to attach to.
 */
export const injectLeadingContext = (
  messages: readonly OcMessage[],
  blocks: readonly string[],
) => {
  if (blocks.length === 0) return;
  const m = lastUserMessage(messages);
  if (!m) return;
  const parts: Part[] = blocks.map((text, i) => ({
    id: `mimir-ctx-${Date.now()}-${i}`,
    sessionID: m.info.sessionID,
    messageID: m.info.id,
    type: "text",
    text,
    synthetic: true,
  }));
  m.parts.unshift(...parts);
};
