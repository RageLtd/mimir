import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@opencode-ai/sdk";
import {
  extractLastUserPrompt,
  injectLeadingContext,
  lastUserMessage,
  type OcMessage,
} from "./message-inject";

const userInfo = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 0 },
  agent: "test",
  model: { providerID: "p", modelID: "m" },
});

const assistantInfo = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "assistant",
  time: { created: 0, completed: 1 },
  parentID: "u0",
  modelID: "m",
  providerID: "p",
  mode: "chat",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
});

const textPart = (
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
): Part => ({ id, sessionID, messageID, type: "text", text });

const userMsg = (
  id: string,
  sessionID: string,
  texts: string[],
): OcMessage => ({
  info: userInfo(id, sessionID),
  parts: texts.map((t, i) => textPart(`${id}-p${i}`, sessionID, id, t)),
});

describe("lastUserMessage", () => {
  test("returns the most recent user message", () => {
    const messages: OcMessage[] = [
      userMsg("u1", "s", ["first"]),
      { info: assistantInfo("a1", "s"), parts: [] },
      userMsg("u2", "s", ["second"]),
    ];
    expect(lastUserMessage(messages)?.info.id).toBe("u2");
  });

  test("returns undefined when there is no user message", () => {
    const messages: OcMessage[] = [{ info: assistantInfo("a1", "s"), parts: [] }];
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
    const messages: OcMessage[] = [{ info: assistantInfo("a1", "s"), parts: [] }];
    expect(extractLastUserPrompt(messages)).toBe("");
  });
});

describe("injectLeadingContext", () => {
  test("prepends blocks as synthetic text parts on the last user message", () => {
    const messages = [userMsg("u1", "sess", ["the user's ask"])];
    injectLeadingContext(messages, ["<boot_context/>", "<voice_anchor/>"]);

    const parts = messages[0]?.parts ?? [];
    // Injected blocks lead, in order, before the original user text.
    expect(parts.map((p) => (p.type === "text" ? p.text : ""))).toEqual([
      "<boot_context/>",
      "<voice_anchor/>",
      "the user's ask",
    ]);
  });

  test("injected parts carry the target message's sessionID and messageID", () => {
    const messages = [userMsg("u9", "sess-9", ["hi"])];
    injectLeadingContext(messages, ["<x/>"]);

    const injected = messages[0]?.parts[0];
    expect(injected?.type).toBe("text");
    expect(injected?.sessionID).toBe("sess-9");
    expect(injected?.messageID).toBe("u9");
  });

  test("is a no-op when there are no blocks", () => {
    const messages = [userMsg("u1", "s", ["only"])];
    injectLeadingContext(messages, []);
    expect(messages[0]?.parts).toHaveLength(1);
  });

  test("is a no-op when there is no user message to attach to", () => {
    const messages: OcMessage[] = [{ info: assistantInfo("a1", "s"), parts: [] }];
    injectLeadingContext(messages, ["<x/>"]);
    expect(messages[0]?.parts).toHaveLength(0);
  });
});
