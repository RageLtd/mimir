import { describe, expect, test } from "bun:test";
import {
  buildUserMessage,
  computeGaugePromptTokens,
  createMessageQueue,
} from "./runner";

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

describe("computeGaugePromptTokens", () => {
  // The shapes here mirror the runtime payload from
  // `@anthropic-ai/sdk` BetaUsage / BetaIterationsUsage. We assemble them
  // structurally because the SDK types include many optional fields that
  // would clutter the test fixtures and aren't load-bearing for this
  // computation. Cast at the call boundary, never inside the helper.
  const usage = (u: unknown) =>
    computeGaugePromptTokens(u as Parameters<typeof computeGaugePromptTokens>[0]);

  test("returns 0 when usage is undefined", () => {
    expect(usage(undefined)).toBe(0);
  });

  test("falls back to cumulative totals when iterations is null", () => {
    expect(
      usage({
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
        iterations: null,
      }),
    ).toBe(115);
  });

  test("falls back to cumulative totals when iterations is empty array", () => {
    expect(
      usage({
        input_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 0,
        iterations: [],
      }),
    ).toBe(10);
  });

  test("uses last message iteration instead of cumulative across iterations", () => {
    // Six tool cycles with a 30k cached prefix. Cumulative top-level would
    // sum to ~180k, but the gauge should report ~32k — the size of the
    // input on the final API call.
    const result = usage({
      input_tokens: 12_000, // cumulative uncached across 6 calls
      cache_read_input_tokens: 150_000, // cumulative cache reads
      cache_creation_input_tokens: 30_000, // cumulative cache creates
      iterations: [
        {
          type: "message",
          input_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 30_000,
        },
        {
          type: "message",
          input_tokens: 1_500,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
        },
        {
          type: "message",
          input_tokens: 2_500,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
        },
        {
          type: "message",
          input_tokens: 3_000,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
        },
        {
          type: "message",
          input_tokens: 3_500,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
        },
        {
          type: "message",
          input_tokens: 1_300,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
        },
      ],
    });
    expect(result).toBe(1_300 + 30_000);
  });

  test("skips trailing compaction iterations to find the last message iteration", () => {
    const result = usage({
      input_tokens: 999,
      cache_read_input_tokens: 999,
      cache_creation_input_tokens: 999,
      iterations: [
        {
          type: "message",
          input_tokens: 500,
          cache_read_input_tokens: 25_000,
          cache_creation_input_tokens: 0,
        },
        {
          type: "compaction",
          input_tokens: 100_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 100_000,
        },
      ],
    });
    expect(result).toBe(25_500);
  });

  test("still reports cumulative when no message iteration exists", () => {
    expect(
      usage({
        input_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        iterations: [
          {
            type: "compaction",
            input_tokens: 99,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      }),
    ).toBe(6);
  });
});
