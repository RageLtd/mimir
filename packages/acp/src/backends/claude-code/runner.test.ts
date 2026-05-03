import { describe, expect, test } from "bun:test";
import { buildUserMessage, createMessageQueue } from "./runner";

const expectArrayContent = (content: unknown) => {
  if (typeof content === "string") {
    throw new Error("expected MessageParam.content to be an array");
  }
  if (!Array.isArray(content)) {
    throw new Error("expected MessageParam.content to be an array");
  }
  return content;
};

describe("buildUserMessage", () => {
  test("wraps plain text into a user MessageParam with parent_tool_use_id null", () => {
    const msg = buildUserMessage("hello world", undefined);
    expect(msg.type).toBe("user");
    expect(msg.parent_tool_use_id).toBe(null);
    expect(msg.message.role).toBe("user");
    const content = expectArrayContent(msg.message.content);
    expect(content).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("uses promptBlocks path when provided", () => {
    const blocks = [{ type: "text" as const, text: "from blocks" }];
    const msg = buildUserMessage("ignored", blocks);
    const content = expectArrayContent(msg.message.content);
    expect(content[0]).toMatchObject({ text: "from blocks" });
  });

  test("falls back to prompt text when promptBlocks is empty", () => {
    const msg = buildUserMessage("fallback text", []);
    const content = expectArrayContent(msg.message.content);
    expect(content).toEqual([{ type: "text", text: "fallback text" }]);
  });
});

describe("createMessageQueue", () => {
  test("yields pushed messages FIFO", async () => {
    const { iterable, push, close } = createMessageQueue();
    const a = buildUserMessage("a", undefined);
    const b = buildUserMessage("b", undefined);
    const c = buildUserMessage("c", undefined);
    push(a);
    push(b);
    push(c);
    close();
    const out = [];
    for await (const m of iterable) out.push(m);
    expect(out).toEqual([a, b, c]);
  });

  test("parks the iterator on empty queue and resumes on push", async () => {
    const { iterable, push, close } = createMessageQueue();
    const iter = iterable[Symbol.asyncIterator]();

    const first = buildUserMessage("first", undefined);
    setTimeout(() => push(first), 5);
    const r1 = await iter.next();
    expect(r1.done).toBe(false);
    expect(r1.value).toBe(first);

    const second = buildUserMessage("second", undefined);
    setTimeout(() => {
      push(second);
      close();
    }, 5);
    const r2 = await iter.next();
    expect(r2.value).toBe(second);
    const r3 = await iter.next();
    expect(r3.done).toBe(true);
  });

  test("close drops further pushes", async () => {
    const { iterable, push, close } = createMessageQueue();
    push(buildUserMessage("kept", undefined));
    close();
    push(buildUserMessage("dropped", undefined));
    const out = [];
    for await (const m of iterable) out.push(m);
    expect(out.length).toBe(1);
    const first = out[0];
    if (!first) throw new Error("expected first item");
    expect(expectArrayContent(first.message.content)).toEqual([
      { type: "text", text: "kept" },
    ]);
  });
});
