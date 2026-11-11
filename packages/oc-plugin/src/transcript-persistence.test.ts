import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import {
  _extractionWatermarks,
  _summaryWatermarks,
  convertMessage,
  distillBeforeCompaction,
  persistSessionTranscript,
  type TranscriptClient,
} from "./transcript-persistence";

const cleanup: (() => void)[] = [];
afterEach(() => {
  _extractionWatermarks.clear();
  _summaryWatermarks.clear();
  for (const close of cleanup.splice(0)) close();
});

describe("convertMessage — V2 context records", () => {
  test("reads and trims user text directly", () => {
    expect(
      convertMessage({ type: "user", id: "u1", text: " first\nsecond " }),
    ).toEqual({
      role: "user",
      content: "first\nsecond",
    });
    expect(convertMessage({ type: "user", id: "u2", text: " \n " })).toBeNull();
  });

  test("maps assistant text and parsed tool state inputs", () => {
    expect(
      convertMessage({
        type: "assistant",
        id: "a1",
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: { input: { filePath: "/x.ts" } },
          },
          { type: "reasoning", text: "private reasoning" },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read",
          input: { filePath: "/x.ts" },
        },
      ],
    });
  });

  test("does not invent tool calls from streaming inputs or auxiliary records", () => {
    expect(
      convertMessage({
        type: "assistant",
        id: "a",
        content: [
          { type: "tool", id: "c", name: "read", state: { input: '{"file' } },
          { type: "reasoning", text: "private reasoning" },
        ],
      }),
    ).toBeNull();
    for (const type of [
      "compaction",
      "system",
      "synthetic",
      "idle",
      "agent-switched",
    ])
      expect(convertMessage({ type, id: "noise" })).toBeNull();
  });
});

describe("persistSessionTranscript — V2 context and ID checkpoint", () => {
  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const config = {
    serverUrl: "http://localhost",
    apiKey: "key",
    userMemoryDb: ":memory:",
  };
  const REPLICA_ENV = "MIMIR_ORG_REPLICA_DB";
  /** A run that extracts opens the replica: point it away from the live one. */
  const useScratchReplica = () => {
    const dir = mkdtempSync(join(tmpdir(), "mimir-oc-persist-test-"));
    const previous = process.env[REPLICA_ENV];
    process.env[REPLICA_ENV] = join(dir, "replica.db");
    cleanup.push(() => {
      if (previous === undefined) delete process.env[REPLICA_ENV];
      else process.env[REPLICA_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    });
  };
  const extracted = { ok: true as const, memories: [], skipped: null };

  test("reads direct readonly context and advances over auxiliary records", async () => {
    const calls: string[] = [];
    const client: TranscriptClient = {
      session: {
        context: async ({ sessionID }) => {
          calls.push(sessionID);
          return [{ id: "idle", type: "idle" }];
        },
      },
    };
    await persistSessionTranscript("s", "/repo", config, log, client);
    await persistSessionTranscript("s", "/repo", config, log, client);
    expect(calls).toEqual(["s", "s"]);
    expect(_extractionWatermarks.get("s")).toBe("idle");
  });

  test("keeps the watermark on rejected fetch and recovers from shrinking context", async () => {
    _extractionWatermarks.set("s", "old-last");
    await persistSessionTranscript("s", "/repo", config, log, {
      session: {
        context: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(_extractionWatermarks.get("s")).toBe("old-last");
    await persistSessionTranscript("s", "/repo", config, log, {
      session: { context: async () => [{ id: "idle", type: "idle" }] },
    });
    expect(_extractionWatermarks.get("s")).toBe("idle");
  });

  for (const length of [2, 4]) {
    test(`processes every disjoint postcompaction record at length ${length}`, async () => {
      useScratchReplica();
      const seen: unknown[] = [];
      const ops = {
        extractionConfig: async () => ({
          baseUrl: "http://unused",
          model: "test",
        }),
        extractFromConversation: async (_config, messages) => {
          seen.push(messages);
          return extracted;
        },
      } satisfies NonNullable<Parameters<typeof persistSessionTranscript>[5]>;
      const user = (id: string) =>
        ({ type: "user", id, text: id }) satisfies Parameters<
          typeof convertMessage
        >[0];
      const old = [user("old-1"), user("old-2")];
      await persistSessionTranscript(
        "s",
        "/repo",
        config,
        log,
        { session: { context: async () => old } },
        ops,
      );
      expect(_extractionWatermarks.get("s")).toBe("old-2");
      const replacement = Array.from({ length }, (_value, i) =>
        user(`new-${i}`),
      );
      const client = { session: { context: async () => replacement } };
      await persistSessionTranscript("s", "/repo", config, log, client, ops);
      await persistSessionTranscript("s", "/repo", config, log, client, ops);
      expect(seen).toEqual([
        old.map((message) => ({ role: "user", content: message.text })),
        replacement.map((message) => ({ role: "user", content: message.text })),
      ]);
      expect(_extractionWatermarks.get("s")).toBe(`new-${length - 1}`);
    });
  }

  test("starts after the checkpoint and advances when extraction is unconfigured", async () => {
    _extractionWatermarks.set("s", "old");
    let extractionCalls = 0;
    await persistSessionTranscript(
      "s",
      "/repo",
      config,
      log,
      {
        session: {
          context: async () => [
            { id: "old", type: "user", text: "already processed" },
            { id: "new", type: "user", text: "new" },
          ],
        },
      },
      {
        extractionConfig: async () => null,
        extractFromConversation: async () => {
          extractionCalls++;
          return { ok: true, memories: [], skipped: "test" };
        },
      },
    );
    expect(extractionCalls).toBe(0);
    expect(_extractionWatermarks.get("s")).toBe("new");
  });

  test("a gate skip keeps the watermark, so the next idle carries the turn with it", async () => {
    _extractionWatermarks.set("s", "old");
    const seen: unknown[] = [];
    const turns = [
      { type: "user", id: "old", text: "already processed" },
      { type: "user", id: "turn-1", text: "first prompt" },
    ];
    const ops = {
      extractionConfig: async () => ({
        baseUrl: "http://unused",
        model: "test",
      }),
      extractFromConversation: async (_config, messages) => {
        seen.push(messages);
        return { ok: true, memories: [], skipped: "fewer than 2 user turns" };
      },
    } satisfies NonNullable<Parameters<typeof persistSessionTranscript>[5]>;
    const client: TranscriptClient = {
      session: { context: async () => turns },
    };
    await persistSessionTranscript("s", "/repo", config, log, client, ops);
    expect(_extractionWatermarks.get("s")).toBe("old");

    turns.push({ type: "user", id: "turn-2", text: "second prompt" });
    await persistSessionTranscript("s", "/repo", config, log, client, ops);
    expect(seen[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "user", content: "second prompt" },
    ]);
  });

  describe("before a compaction", () => {
    const onePrompt: TranscriptClient = {
      session: {
        context: async () => [
          { type: "user", id: "turn-1", text: "first prompt" },
        ],
      },
    };

    const closing = (
      summary: Awaited<
        ReturnType<
          NonNullable<
            Parameters<typeof distillBeforeCompaction>[5]
          >["summarizeToReplica"]
        >
      >,
      outcome: Awaited<ReturnType<typeof extractFromConversation>> = extracted,
    ) => {
      const seen = {
        summarized: [] as unknown[],
        extractions: [] as unknown[],
        syncs: 0,
      };
      const ops = {
        extractionConfig: async () => ({
          baseUrl: "http://unused",
          model: "test",
        }),
        summarizeToReplica: async (opts) => {
          seen.summarized.push(opts.messages);
          return summary;
        },
        extractFromConversation: async (_config, _messages, options) => {
          seen.extractions.push(options);
          return outcome;
        },
        syncAfterDistill: async () => {
          seen.syncs++;
        },
      } satisfies NonNullable<Parameters<typeof distillBeforeCompaction>[5]>;
      return { seen, ops };
    };

    test("stores a summary, reads a one-prompt window's facts as its last reading, and syncs", async () => {
      useScratchReplica();
      const { seen, ops } = closing({
        ok: true,
        id: "memory:summary",
        skipped: null,
      });

      await distillBeforeCompaction("s", "/repo", config, log, onePrompt, ops);

      expect(seen.summarized).toEqual([
        [{ role: "user", content: "first prompt" }],
      ]);
      expect(seen.extractions).toEqual([{ closing: true }]);
      expect(seen.syncs).toBe(1);
      expect(_extractionWatermarks.get("s")).toBe("turn-1");
    });

    test("a failed summary keeps the watermark and distils nothing else", async () => {
      useScratchReplica();
      const { seen, ops } = closing({ ok: false, id: null, skipped: null });

      await distillBeforeCompaction("s", "/repo", config, log, onePrompt, ops);

      expect(seen.extractions).toEqual([]);
      expect(seen.syncs).toBe(0);
      expect(_extractionWatermarks.has("s")).toBe(false);
    });

    test("a window too small to hold anything settles without a sync", async () => {
      useScratchReplica();
      const { seen, ops } = closing(
        { ok: true, id: null, skipped: "window too small" },
        { ok: true, memories: [], skipped: "conversation too short" },
      );

      await distillBeforeCompaction("s", "/repo", config, log, onePrompt, ops);

      expect(seen.syncs).toBe(0);
      expect(_extractionWatermarks.get("s")).toBe("turn-1");
    });
  });

  test("serializes overlapping callers so only one extracts the committed delta", async () => {
    useScratchReplica();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let fetches = 0;
    let extractions = 0;
    const ops = {
      extractionConfig: async () => ({
        baseUrl: "http://unused",
        model: "test",
      }),
      extractFromConversation: async () => {
        extractions++;
        entered.resolve();
        await release.promise;
        return extracted;
      },
    } satisfies NonNullable<Parameters<typeof persistSessionTranscript>[5]>;
    const client: TranscriptClient = {
      session: {
        context: async () => {
          fetches++;
          return [{ type: "user", id: "new", text: "new" }];
        },
      },
    };
    const idle = persistSessionTranscript(
      "s",
      "/repo",
      config,
      log,
      client,
      ops,
    );
    await entered.promise;
    const precompaction = persistSessionTranscript(
      "s",
      "/repo",
      config,
      log,
      client,
      ops,
    );
    await Promise.resolve();
    expect(fetches).toBe(1);
    release.resolve();
    await Promise.all([idle, precompaction]);
    expect(fetches).toBe(2);
    expect(extractions).toBe(1);
    expect(_extractionWatermarks.get("s")).toBe("new");
  });

  test("transport extraction failure retains the ID and retries the identical delta", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        requests.push(await request.text());
        return new Response("unavailable", { status: 503 });
      },
    });
    cleanup.push(() => server.stop(true));
    _extractionWatermarks.set("s", "old");
    const client: TranscriptClient = {
      session: {
        context: async () => [
          { type: "user", id: "old", text: "already processed" },
          {
            type: "user",
            id: "new-1",
            text: "An architecture decision useful in future conversations. ".repeat(
              4,
            ),
          },
          {
            type: "user",
            id: "new-2",
            text: "A second substantive technical turn. ".repeat(4),
          },
        ],
      },
    };
    const ops = {
      extractionConfig: async () => ({
        baseUrl: server.url.toString(),
        model: "test",
      }),
      extractFromConversation,
    };
    await persistSessionTranscript("s", "/repo", config, log, client, ops);
    expect(_extractionWatermarks.get("s")).toBe("old");
    await persistSessionTranscript("s", "/repo", config, log, client, ops);
    expect(_extractionWatermarks.get("s")).toBe("old");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]).not.toContain("already processed");
  });
});
