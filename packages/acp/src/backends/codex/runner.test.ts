import { describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createCodexEventTranslator } from "./runner";

describe("Codex runner event translation", () => {
  test("streams agent message updates as deltas before item completion", () => {
    const translate = createCodexEventTranslator();
    const events = [
      {
        type: "item.started",
        item: { id: "msg_1", type: "agent_message", text: "" },
      },
      {
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", text: "Hello" },
      },
      {
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", text: "Hello world" },
      },
      {
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", text: "Hello world" },
      },
    ] satisfies readonly ThreadEvent[];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ]);
  });

  test("emits completed agent message text when no updates were seen", () => {
    const translate = createCodexEventTranslator();
    const event = {
      type: "item.completed",
      item: { id: "msg_1", type: "agent_message", text: "Done." },
    } satisfies ThreadEvent;

    expect([...translate(event)]).toEqual([{ type: "text", text: "Done." }]);
  });

  test("streams reasoning updates as thinking deltas", () => {
    const translate = createCodexEventTranslator();
    const events = [
      {
        type: "item.updated",
        item: { id: "reason_1", type: "reasoning", text: "First" },
      },
      {
        type: "item.completed",
        item: { id: "reason_1", type: "reasoning", text: "First pass" },
      },
    ] satisfies readonly ThreadEvent[];

    const output = events.flatMap((event) => [...translate(event)]);

    expect(output).toEqual([
      { type: "thinking", text: "First" },
      { type: "thinking", text: " pass" },
    ]);
  });
});
