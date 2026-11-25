/**
 * Extraction tests — stub OpenAI-compatible server. Covers the parse
 * contract (plain array, fenced array, junk), auth-header behavior for
 * keyed vs keyless endpoints, and failure degradation to [].
 */

import { describe, expect, test } from "bun:test";
import {
  buildExtractionText,
  type ConversationMessage,
  EXTRACTION_MAX_CHARS,
  type ExtractionConfig,
  extractFromConversation,
  extractMemories,
  parseExtraction,
  prepareExtraction,
} from "./extract";
import {
  refuseConnection,
  STAND_IN_BASE_URL,
  withFetch,
} from "./fetch-stand-in";

type Captured = {
  auth: string | null;
  model: string | null;
  system: string | null;
};

const withStub = (
  reply: (body: {
    model?: string;
    messages?: { role: string; content: string }[];
  }) => Response,
  fn: (config: ExtractionConfig, captured: Captured) => Promise<void>,
  apiKey?: string,
) => {
  const captured: Captured = { auth: null, model: null, system: null };
  const config: ExtractionConfig = {
    baseUrl: STAND_IN_BASE_URL,
    model: "test-model",
    ...(apiKey ? { apiKey } : {}),
  };
  return withFetch(
    async (req) => {
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
    () => fn(config, captured),
  );
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
    await withFetch(refuseConnection, async () => {
      const memories = await extractMemories(
        { baseUrl: STAND_IN_BASE_URL, model: "m" },
        "conversation",
      );
      expect(memories).toBeNull();
    });
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
    const filler = "x".repeat(EXTRACTION_MAX_CHARS * 0.75);
    const text = buildExtractionText([
      user(filler),
      user(filler),
      user("the final word"),
    ]);
    // Last message always present; one filler fits the budget whole
    // and the one before it is cut to what is left.
    expect(text.endsWith("user: the final word")).toBe(true);
    expect(text.split("\n")).toHaveLength(3);
    expect(text.length).toBeLessThanOrEqual(EXTRACTION_MAX_CHARS + 2);
  });

  test("an oversized message is cut to the remaining budget, not dropped with everything before it", () => {
    const text = buildExtractionText([
      user(
        `We decided the relay stays blind. ${"x".repeat(EXTRACTION_MAX_CHARS * 2)}`,
      ),
      assistant("Merged the branch as 4a33913 and the gate is green."),
    ]);
    expect(text.startsWith("user: We decided the relay stays blind.")).toBe(
      true,
    );
    expect(
      text.endsWith(
        "assistant: Merged the branch as 4a33913 and the gate is green.",
      ),
    ).toBe(true);
    expect(text.split("\n")[0]?.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(EXTRACTION_MAX_CHARS + 1);
  });

  test("an assistant message takes at most half the budget, so the prompt before it is still read", () => {
    const text = buildExtractionText([
      user("We decided the relay stays blind."),
      assistant("y".repeat(EXTRACTION_MAX_CHARS * 2)),
    ]);
    const [first, second] = text.split("\n");
    expect(first).toBe("user: We decided the relay stays blind.");
    expect(second?.length).toBeLessThanOrEqual(EXTRACTION_MAX_CHARS / 2);
    expect(second?.endsWith("…")).toBe(true);
  });

  test("a sliver of budget is left empty rather than filled with a fragment", () => {
    const text = buildExtractionText([
      user("an earlier question that will not fit in what is left"),
      user("y".repeat(EXTRACTION_MAX_CHARS - 10)),
    ]);
    expect(text.split("\n")).toHaveLength(1);
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

  test("a closing run extracts from a single user turn", async () => {
    await withStub(
      () => completion('["a closing memory"]'),
      async (config) => {
        const padding = "we discussed the compaction threshold ".repeat(10);
        const outcome = await extractFromConversation(
          config,
          [user(padding), assistant(padding)],
          { closing: true },
        );
        expect(outcome.skipped).toBeNull();
        expect(outcome.memories).toEqual(["a closing memory"]);
      },
    );
  });

  const substantive = [
    user("a first message with plenty of words inside it".repeat(3)),
    user("a second message with plenty of words inside it".repeat(3)),
  ];

  /** The failed outcome's reason, or why the outcome was not a failure. */
  const failureReason = async (reply: () => Response) => {
    const seen: { reason: string } = { reason: "extraction did not fail" };
    await withStub(reply, async (config) => {
      const outcome = await extractFromConversation(config, substantive);
      if (!outcome.ok) seen.reason = outcome.reason;
    });
    return seen.reason;
  };

  test("transport failure reports ok:false and what failed", async () => {
    await withFetch(refuseConnection, async () => {
      const outcome = await extractFromConversation(
        { baseUrl: STAND_IN_BASE_URL, model: "m" },
        substantive,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toStartWith("completion failed: ");
    });
  });

  test("an HTTP error's status and detail are the reason", async () => {
    expect(
      await failureReason(() => new Response("overloaded", { status: 500 })),
    ).toBe("completion failed: HTTP 500: overloaded");
  });

  test("a model that reasons its token limit away says so: no content, finish_reason length", async () => {
    expect(
      await failureReason(() =>
        Response.json({
          choices: [
            {
              finish_reason: "length",
              message: { reasoning_content: "Let me think about this…" },
            },
          ],
        }),
      ),
    ).toBe("completion returned empty content (finish_reason: length)");
  });

  test("a completion that is not a string array is named as one", async () => {
    expect(await failureReason(() => completion('{"not": "an array"}'))).toBe(
      "completion is not a JSON array of strings",
    );
  });
});

describe("prepareExtraction", () => {
  test("single user turn skips", () => {
    expect(
      prepareExtraction([
        user("only one user turn here"),
        assistant("a reasonably long assistant reply for the filter"),
      ]),
    ).toEqual({ skipped: "fewer than 2 user turns" });
  });

  test("user turns without text do not count toward the gate", () => {
    expect(
      prepareExtraction([
        user("a single real user turn"),
        { role: "user", content: [{ type: "image", image: "x" }] },
      ]),
    ).toEqual({ skipped: "fewer than 2 user turns" });
  });

  test("a closing run does not wait for a second user turn", () => {
    const padding = "we discussed the compaction threshold ".repeat(10);
    const prepared = prepareExtraction([user(padding), assistant(padding)], {
      closing: true,
    });
    expect("request" in prepared).toBe(true);
  });

  test("a closing run still skips a conversation too short to hold anything", () => {
    expect(prepareExtraction([user("hi")], { closing: true })).toEqual({
      skipped: "conversation too short",
    });
  });

  test("short rendered conversation skips", () => {
    expect(prepareExtraction([user("hi"), user("ok")])).toEqual({
      skipped: "conversation too short",
    });
  });

  test("substantive conversation yields the extraction request verbatim", () => {
    const padding = "we discussed the compaction threshold ".repeat(10);
    const messages = [user(padding), assistant(padding), user(padding)];
    const prepared = prepareExtraction(messages);
    if (!("request" in prepared)) {
      throw new Error(`expected a request, got skip: ${prepared.skipped}`);
    }
    const { request } = prepared;
    expect(request.system).toContain(
      "You extract factual memories from development conversations",
    );
    expect(request.system).toContain(
      'Output format: ["memory 1", "memory 2", ...]',
    );
    expect(request.prompt).toBe(buildExtractionText(messages));
    // Room for a local reasoning model to think and still answer.
    expect(request.maxTokens).toBe(16_384);
  });
});

describe("parseExtraction", () => {
  test("plain JSON string array", () => {
    expect(parseExtraction('["fact one", "fact two"]')).toEqual([
      "fact one",
      "fact two",
    ]);
  });

  test("empty array is an honest nothing", () => {
    expect(parseExtraction("[]")).toEqual([]);
  });

  test("```json fenced array", () => {
    expect(parseExtraction('```json\n["fenced fact"]\n```')).toEqual([
      "fenced fact",
    ]);
  });

  test("non-JSON is null", () => {
    expect(parseExtraction("Here are the memories: none")).toBeNull();
  });

  test("non-array JSON is null", () => {
    expect(parseExtraction('{"not": "an array"}')).toBeNull();
  });

  test("array with a non-string element is null", () => {
    expect(parseExtraction('["ok", 42]')).toBeNull();
  });
});
