/**
 * The conversation as the engine hands it — `$.session.messages({ as:
 * "api" })`, Messages-API form, newest 4096 — and the anchor that marks
 * where the last distillation stopped.
 *
 * The anchor is a count plus a mark of the message at it. Where the
 * message at `count` still bears the mark, the delta is everything after;
 * where it does not (the window slid past 4096 rows, or the conversation
 * was compacted), the mark is searched for downward from `count` and the
 * delta resumes after it. Nothing found, the whole window is new.
 *
 * Pure: `$` never enters this file.
 */

import type { MimirAnchor } from "../types";

export type Block = {
  readonly type: string;
  readonly [field: string]: unknown;
};

/** One message in Messages-API form, as the engine hands it. */
export type Message = {
  readonly role: "user" | "assistant";
  readonly content: readonly Block[];
};

/** A message in either form the engine uses: API blocks, or a row's text. */
type Textual =
  | Message
  | { readonly role: "user" | "assistant"; readonly text: string };

export const NO_ANCHOR: MimirAnchor = { count: 0, mark: "" };

/** How much of a message's text the mark keeps; whitespace is dropped first. */
const MARK_CHARS = 512;

const isTextBlock = (block: Block): block is Block & { text: string } =>
  block.type === "text" && typeof block.text === "string";

const textOf = (message: Textual) =>
  "text" in message
    ? message.text
    : message.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("");

/**
 * The mark of a message: its role and its text less whitespace. The engine
 * joins a row's text blocks its own way; without whitespace the row and
 * the API form of the same message mark alike.
 */
const markOf = (message: Textual) =>
  `${message.role}:${textOf(message).replace(/\s+/g, "").slice(0, MARK_CHARS)}`;

export const anchorOf = (messages: readonly Textual[]): MimirAnchor => {
  const last = messages.at(-1);
  return last === undefined
    ? NO_ANCHOR
    : { count: messages.length, mark: markOf(last) };
};

/** The messages after the anchor; see the module doc for the relocation. */
export const deltaSince = <M extends Message>(
  messages: readonly M[],
  anchor: MimirAnchor,
) => {
  if (anchor.count === 0) return messages;
  for (let i = Math.min(anchor.count, messages.length) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && markOf(message) === anchor.mark)
      return messages.slice(i + 1);
  }
  return messages;
};

const MEDIA_BLOCKS = new Set(["image", "document"]);

const textParts = (content: unknown) =>
  Array.isArray(content)
    ? content.filter((part) => part?.type === "text")
    : content;

/**
 * The message less its media: inline images and documents are no use to
 * the brain and would otherwise cross stdin whole, inside a tool_result's
 * content as well as at the top level.
 */
export const slim = (message: Message): Message => ({
  role: message.role,
  content: message.content
    .filter((block) => !MEDIA_BLOCKS.has(block.type))
    .map((block) =>
      block.type === "tool_result"
        ? { ...block, content: textParts(block.content) }
        : block,
    ),
});
