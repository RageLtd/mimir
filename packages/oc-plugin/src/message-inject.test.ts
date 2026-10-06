import { describe, expect, test } from "bun:test";
import { Message } from "@opencode/ai";
import {
  extractLastUserPrompt,
  injectLeadingContext,
  lastUserMessage,
  type OcMessage,
} from "./message-inject";

const userMsg = (id: string, _sessionID: string, texts: string[]) =>
  Message.make({
    id,
    role: "user",
    content: texts.map((text) => Message.text(text)),
  });

const assistantMsg = (id: string) =>
  Message.make({ id, role: "assistant", content: [] });

describe("lastUserMessage", () => {
  test("returns the most recent user message", () => {
    const messages: OcMessage[] = [
      userMsg("u1", "s", ["first"]),
      assistantMsg("a1"),
      userMsg("u2", "s", ["second"]),
    ];
    expect(lastUserMessage(messages)?.id).toBe("u2");
  });

  test("returns undefined when there is no user message", () => {
    const messages: OcMessage[] = [assistantMsg("a1")];
    expect(lastUserMessage(messages)).toBeUndefined();
  });
});

describe("extractLastUserPrompt", () => {
  test("joins the text parts of the last user message", () => {
    const messages = [userMsg("u1", "s", ["line one", "line two"])];
    expect(extractLastUserPrompt(messages)).toBe("line one\nline two");
  });

  test("reads the LAST user message, not an earlier one", () => {
    const messages: OcMessage[] = [
      userMsg("u1", "s", ["old"]),
      userMsg("u2", "s", ["current"]),
    ];
    expect(extractLastUserPrompt(messages)).toBe("current");
  });

  test("returns empty string when there is no user message", () => {
    const messages: OcMessage[] = [assistantMsg("a1")];
    expect(extractLastUserPrompt(messages)).toBe("");
  });
});

describe("injectLeadingContext", () => {
  test("prepends blocks as synthetic text parts on the last user message", () => {
    const messages = [userMsg("u1", "sess", ["the user's ask"])];
    injectLeadingContext(messages, ["<boot_context/>", "<voice_anchor/>"]);

    const parts = messages[0]?.content ?? [];
    // Injected blocks lead, in order, before the original user text.
    expect(parts.map((p) => (p.type === "text" ? p.text : ""))).toEqual([
      "<boot_context/>",
      "<voice_anchor/>",
      "the user's ask",
    ]);
  });

  test("replaces readonly content without mutating the original message", () => {
    const messages = [userMsg("u9", "sess-9", ["hi"])];
    const original = messages[0];
    injectLeadingContext(messages, ["<x/>"]);

    const injected = messages[0]?.content[0];
    expect(injected?.type).toBe("text");
    expect(messages[0]?.id).toBe("u9");
    expect(original?.content).toHaveLength(1);
  });

  test("preserves non-text content and message metadata", () => {
    const call = {
      type: "tool-call",
      id: "call-1",
      name: "read",
      input: { path: "song.ts" },
    } as const;
    const original = Message.make({
      id: "user-1",
      role: "user",
      metadata: { source: "developer" },
      native: { opaque: "keep" },
      content: [Message.text("question"), call],
    });
    const messages = [original];
    injectLeadingContext(messages, ["context"]);
    expect(messages[0]?.metadata).toEqual(original.metadata);
    expect(messages[0]?.native).toEqual(original.native);
    expect(messages[0]?.content[2]).toEqual(call);
    expect(original.content).toHaveLength(2);
  });

  test("is a no-op when there are no blocks", () => {
    const messages = [userMsg("u1", "s", ["only"])];
    injectLeadingContext(messages, []);
    expect(messages[0]?.content).toHaveLength(1);
  });

  test("is a no-op when there is no user message to attach to", () => {
    const messages: OcMessage[] = [assistantMsg("a1")];
    injectLeadingContext(messages, ["<x/>"]);
    expect(messages[0]?.content).toHaveLength(0);
  });
});
