/**
 * Extraction tests — stub OpenAI-compatible server. Covers the parse
 * contract (plain array, fenced array, junk), auth-header behavior for
 * keyed vs keyless endpoints, and failure degradation to [].
 */

import { describe, expect, test } from "bun:test";
import {
  buildExtractionText,
  type ConversationMessage,
  type ExtractionConfig,
  extractFromConversation,
  extractMemories,
} from "./extract";

type Captured = {
  auth: string | null;
  model: string | null;
  system: string | null;
};

const withStub = async (
  reply: (body: {
    model?: string;
    messages?: { role: string; content: string }[];
  }) => Response,
  fn: (config: ExtractionConfig, captured: Captured) => Promise<void>,
  apiKey?: string,
) => {
  const captured: Captured = { auth: null, model: null, system: null };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as {
        model?: string;
        messages?: { role: string; content: string }[];
      };
      captured.auth = req.headers.get("authorization");
      captured.model = body.model ?? null;
      captured.system =
        body.messages?.find((m) => m.role === "system")?.content ?? null;
      return reply(body);
    },
  });
  const config: ExtractionConfig = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: "test-model",
    ...(apiKey ? { apiKey } : {}),
  };
  await fn(config, captured).finally(() => server.stop(true));
};

const completion = (content: string) =>
  Response.json({ choices: [{ message: { content } }] });

describe("extractMemories", () => {
  test("parses a plain JSON array and sends the right request shape", async () => {
    await withStub(
      () => completion('["fact one", "fact two"]'),
      async (config, captured) => {
        const memories = await extractMemories(config, "user: something real");
        expect(memories).toEqual(["fact one", "fact two"]);
        expect(captured.model).toBe("test-model");
        expect(captured.system).toContain("extract factual memories");
        // Keyless endpoint → no Authorization header at all.
        expect(captured.auth).toBeNull();
      },
    );
  });

  test("strips markdown fences (```json)", async () => {
    await withStub(
      () => completion('```json\n["fenced fact"]\n```'),
      async (config) => {
        expect(await extractMemories(config, "conversation")).toEqual([
          "fenced fact",
        ]);
      },
    );
  });

  test("keyed endpoint sends bearer auth", async () => {
    await withStub(
      () => completion("[]"),
      async (config, captured) => {
        await extractMemories(config, "conversation");
        expect(captured.auth).toBe("Bearer sk-test");
      },
      "sk-test",
    );
  });

  test("non-array and non-string-array outputs are failures (null)", async () => {
    await withStub(
      () => completion('{"not": "an array"}'),
      async (config) => {
        expect(await extractMemories(config, "conversation")).toBeNull();
      },
    );
    await withStub(
      () => completion('["ok", 42]'),
      async (config) => {
        expect(await extractMemories(config, "conversation")).toBeNull();
      },
    );
  });

  test("HTTP failure is null — callers keep their watermark", async () => {
    await withStub(
      () => new Response("overloaded", { status: 500 }),
      async (config) => {
        expect(await extractMemories(config, "conversation")).toBeNull();
      },
    );
  });

  test("unreachable endpoint is null", async () => {
    const memories = await extractMemories(
      { baseUrl: "http://127.0.0.1:45991", model: "m" },
      "conversation",
    );
    expect(memories).toBeNull();
  });

  test("blank conversation short-circuits without a request", async () => {
    let hit = false;
    await withStub(
      () => {
        hit = true;
        return completion("[]");
      },
      async (config) => {
        expect(await extractMemories(config, "   \n  ")).toEqual([]);
        expect(hit).toBe(false);
      },
    );
  });
});

const user = (text: string): ConversationMessage => ({
  role: "user",
  content: text,
});
const assistant = (text: string): ConversationMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("buildExtractionText", () => {
  test("filters tool/system and short assistant lines, renders role-prefixed", () => {
    const text = buildExtractionText([
      { role: "system", content: "system prompt" },
      user("first question about the gateway"),
      { role: "tool", content: [{ type: "text", text: "tool output" }] },
      assistant("ok"), // under 20 chars → dropped
      assistant("the gateway timeout was thirty seconds"),
    ]);
    expect(text).toBe(
      [
        "user: first question about the gateway",
        "assistant: the gateway timeout was thirty seconds",
      ].join("\n"),
    );
  });

  test("keeps the last message whole and fills backward within budget", () => {
    const filler = "x".repeat(3000);
    const text = buildExtractionText([
      user(filler),
      user(filler),
      user("the final word"),
    ]);
    // Last message always present; only one filler fits the 4000 budget.
    expect(text.endsWith("user: the final word")).toBe(true);
    expect(text.split("\n")).toHaveLength(2);
  });
});

describe("extractFromConversation gates", () => {
  test("single user turn skips without a request (server-parity gate)", async () => {
    let hit = false;
    await withStub(
      () => {
        hit = true;
        return completion('["should not happen"]');
      },
      async (config) => {
        const outcome = await extractFromConversation(config, [
          user("only one user turn here"),
          assistant("a reasonably long assistant reply for the filter"),
        ]);
        expect(outcome.ok).toBe(true);
        expect(outcome.skipped).toBe("fewer than 2 user turns");
        expect(hit).toBe(false);
      },
    );
  });

  test("short conversation skips; long one extracts", async () => {
    await withStub(
      () => completion('["a real memory"]'),
      async (config) => {
        const short = await extractFromConversation(config, [
          user("hi"),
          user("ok"),
        ]);
        expect(short.skipped).toBe("conversation too short");

        const padding = "we discussed the compaction threshold ".repeat(10);
        const long = await extractFromConversation(config, [
          user(padding),
          assistant(padding),
          user(padding),
        ]);
        expect(long.ok).toBe(true);
        expect(long.memories).toEqual(["a real memory"]);
      },
    );
  });

  test("transport failure reports ok:false", async () => {
    const outcome = await extractFromConversation(
      { baseUrl: "http://127.0.0.1:45991", model: "m" },
      [
        user("a first message with plenty of words inside it".repeat(3)),
        user("a second message with plenty of words inside it".repeat(3)),
      ],
    );
    expect(outcome.ok).toBe(false);
  });
});
