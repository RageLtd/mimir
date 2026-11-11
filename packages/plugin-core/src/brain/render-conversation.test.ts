/**
 * renderConversation budget tests. Pins: the returned string — "\n" joins
 * included — never runs past maxChars, on the whole-line path, the
 * truncated-line path, and a lone over-long last message; and a window
 * that fits is rendered whole, in order.
 */

import { describe, expect, test } from "bun:test";
import { type ConversationMessage, renderConversation } from "./extract";

/** Budgets of no common factor with the line sizes, so a per-line
 *  off-by-one shows at more than one lucky size. */
const BUDGETS = [100, 137, 250, 501, 999, 2_048];

const shortMessages = (count: number): ConversationMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    role: "user",
    content: `short message ${String(i).padStart(3, "0")}`,
  }));

describe("renderConversation stays within its budget", () => {
  test("many short messages that overflow never exceed maxChars", () => {
    const messages = shortMessages(300);
    for (const maxChars of BUDGETS) {
      const text = renderConversation(messages, maxChars);
      expect({ maxChars, length: text.length }).toEqual({
        maxChars,
        length: Math.min(text.length, maxChars),
      });
    }
  });

  test("an older message cut to the room left never exceeds maxChars", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: `OLDER ${"a long earlier message ".repeat(200)}`,
      },
      ...shortMessages(3),
    ];
    for (const maxChars of BUDGETS.filter((b) => b >= 250)) {
      const text = renderConversation(messages, maxChars);
      // The cut path ran: the older message is present, trimmed.
      expect(text.startsWith("user: OLDER")).toBe(true);
      expect(text).toContain("…");
      expect({ maxChars, length: text.length }).toEqual({
        maxChars,
        length: Math.min(text.length, maxChars),
      });
    }
  });

  test("a single over-long last message never exceeds maxChars", () => {
    const long = `LAST ${"an over-long final message ".repeat(400)}`;
    for (const role of ["user", "assistant"]) {
      for (const maxChars of BUDGETS) {
        const text = renderConversation([{ role, content: long }], maxChars);
        expect(text.startsWith(`${role}: LAST`)).toBe(true);
        expect({ role, maxChars, length: text.length }).toEqual({
          role,
          maxChars,
          length: Math.min(text.length, maxChars),
        });
      }
    }
  });

  test("a window that fits is rendered whole and in order", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        // Short enough to sit under the assistant's half-budget share even
        // at the exact-fit budget below.
        content: [{ type: "text", text: "a reply kept in full" }],
      },
      { role: "user", content: "second prompt" },
    ];
    const expected = [
      "user: first prompt",
      "assistant: a reply kept in full",
      "user: second prompt",
    ].join("\n");
    expect(renderConversation(messages, 10_000)).toBe(expected);
    // Exactly the room it needs, joins included, still keeps every line.
    expect(renderConversation(messages, expected.length)).toBe(expected);
  });
});
