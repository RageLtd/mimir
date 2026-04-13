import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as surreal from "../../db/surreal";
import type { ModelMessage } from "@ai-sdk/provider-utils";

import {
  appendModelMessage,
  finishCompaction,
  getCompactionState,
  getLastModelMessage,
  getModelMessagesSince,
  getRecentModelMessages,
  startCompaction,
  updateTokenCount,
} from "./index";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe("message-log", () => {
  let queryMock: ReturnType<typeof mock>;
  let queryOneMock: ReturnType<typeof mock>;
  let queryFirstMock: ReturnType<typeof mock>;

  beforeEach(() => {
    queryMock = mock(() => Promise.resolve([[]]));
    queryOneMock = mock(() => Promise.resolve([]));
    queryFirstMock = mock(() => Promise.resolve(null));

    spyOn(surreal, "getDb").mockImplementation(
      async () => ({ query: queryMock }) as any,
    );
    spyOn(surreal, "queryOne").mockImplementation(queryOneMock as any);
    spyOn(surreal, "queryFirst").mockImplementation(queryFirstMock as any);
  });

  afterEach(() => {
    mock.restore();
  });

  // -----------------------------------------------------------------------
  // appendModelMessage
  // -----------------------------------------------------------------------

  describe("appendModelMessage", () => {
    test("returns record ID on success", async () => {
      queryMock.mockResolvedValueOnce([
        [{ id: "message_log:[test,999]", role: "user", content: '"Hello"' }],
      ]);

      const id = await appendModelMessage(
        { role: "user", content: "Hello" },
        "my-project",
      );

      expect(id).toBe("message_log:[test,999]");
    });

    test("returns null on database error", async () => {
      queryMock.mockRejectedValueOnce(new Error("Connection refused"));

      const id = await appendModelMessage(
        { role: "user", content: "test" },
        "my-project",
      );

      expect(id).toBeNull();
    });

    test("returns null when query returns empty result", async () => {
      queryMock.mockResolvedValueOnce([[]]);

      const id = await appendModelMessage(
        { role: "user", content: "test" },
        "my-project",
      );

      expect(id).toBeNull();
    });

    test("serializes string content as JSON", async () => {
      queryMock.mockResolvedValueOnce([
        [{ id: "message_log:[p,1]", role: "user", content: '"hi"' }],
      ]);

      await appendModelMessage({ role: "user", content: "hi" }, "p");

      const [, params] = queryMock.mock.calls[0] as [
        string,
        { id: string; fields: Record<string, unknown> },
      ];
      expect(params.fields.content).toBe('"hi"');
      expect(params.fields.role).toBe("user");
    });

    test("serializes tool-result content as JSON array", async () => {
      const toolMessage: ModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_abc",
            toolName: "bash",
            output: { type: "text", value: "command output" },
          },
        ],
      };

      queryMock.mockResolvedValueOnce([
        [{ id: "message_log:[p,1]", role: "tool", content: "..." }],
      ]);

      await appendModelMessage(toolMessage, "p");

      const [, params] = queryMock.mock.calls[0] as [
        string,
        { id: string; fields: Record<string, unknown> },
      ];
      const parsed = JSON.parse(params.fields.content as string);
      expect(parsed).toEqual([
        {
          type: "tool-result",
          toolCallId: "call_abc",
          toolName: "bash",
          output: { type: "text", value: "command output" },
        },
      ]);
    });

    test("serializes assistant content with tool calls as JSON array", async () => {
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "read_file",
            input: { path: "/tmp" },
          },
        ],
      };

      queryMock.mockResolvedValueOnce([
        [{ id: "message_log:[p,1]", role: "assistant", content: "..." }],
      ]);

      await appendModelMessage(assistantMessage, "p");

      const [, params] = queryMock.mock.calls[0] as [
        string,
        { id: string; fields: Record<string, unknown> },
      ];
      const parsed = JSON.parse(params.fields.content as string);
      expect(parsed).toEqual([
        { type: "text", text: "Let me read that file." },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read_file",
          input: { path: "/tmp" },
        },
      ]);
    });

    test("stores project as metadata in fields", async () => {
      queryMock.mockResolvedValueOnce([
        [{ id: "message_log:[proj,1]", role: "user", content: '"x"' }],
      ]);

      await appendModelMessage({ role: "user", content: "x" }, "my-project");

      const [, params] = queryMock.mock.calls[0] as [
        string,
        { id: string; fields: Record<string, unknown> },
      ];
      expect(params.fields.project).toBe("my-project");
    });

    test("does not set created_at — lets SurrealDB default handle it", async () => {
      queryMock.mockResolvedValueOnce([
        [{ id: "message_log:[p,1]", role: "user", content: '"x"' }],
      ]);

      await appendModelMessage({ role: "user", content: "x" }, "p");

      const [, params] = queryMock.mock.calls[0] as [
        string,
        { id: string; fields: Record<string, unknown> },
      ];
      expect(params.fields).not.toHaveProperty("created_at");
    });
  });

  // -----------------------------------------------------------------------
  // getRecentModelMessages
  // -----------------------------------------------------------------------

  describe("getRecentModelMessages", () => {
    test("returns messages reversed to chronological order", async () => {
      // DB returns DESC (newest first) — function reverses to oldest first
      queryOneMock.mockResolvedValueOnce([
        {
          id: "m3",
          project: "p",
          role: "assistant",
          content: '"third"',
          created_at: "2024-01-03",
        },
        {
          id: "m2",
          project: "p",
          role: "user",
          content: '"second"',
          created_at: "2024-01-02",
        },
        {
          id: "m1",
          project: "p",
          role: "user",
          content: '"first"',
          created_at: "2024-01-01",
        },
      ]);

      const result = await getRecentModelMessages(10);

      expect(result).toHaveLength(3);
      // After reversal: first → m1, second → m2, third → m3
      expect(result[0]!.role).toBe("user");
      expect((result[0]! as ModelMessage & { content: string }).content).toBe("first");
      expect(result[2]!.role).toBe("assistant");
      expect((result[2]! as ModelMessage & { content: string }).content).toBe("third");
    });

    test("returns empty array on error", async () => {
      queryOneMock.mockRejectedValueOnce(new Error("DB error"));

      const result = await getRecentModelMessages(10);

      expect(result).toEqual([]);
    });

    test("returns empty array when no messages exist", async () => {
      queryOneMock.mockResolvedValueOnce([]);

      const result = await getRecentModelMessages(10);

      expect(result).toEqual([]);
    });

    test("parses tool messages with content arrays", async () => {
      queryOneMock.mockResolvedValueOnce([
        {
          id: "m1",
          project: "p",
          role: "tool",
          content: JSON.stringify([
            {
              type: "tool-result",
              toolCallId: "call_42",
              toolName: "bash",
              output: { type: "text", value: "result data" },
            },
          ]),
          created_at: "2024-01-01",
        },
      ]);

      const result = await getRecentModelMessages(5);

      expect(result[0]!.role).toBe("tool");
      const content = (result[0]! as ModelMessage & { content: unknown[] }).content;
      expect(content).toEqual([
        {
          type: "tool-result",
          toolCallId: "call_42",
          toolName: "bash",
          output: { type: "text", value: "result data" },
        },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // getModelMessagesSince
  // -----------------------------------------------------------------------

  describe("getModelMessagesSince", () => {
    test("returns messages after the given timestamp", async () => {
      queryOneMock.mockResolvedValueOnce([
        {
          id: "m1",
          project: "p",
          role: "user",
          content: '"after cutoff"',
          created_at: "2024-01-16",
        },
        {
          id: "m2",
          project: "p",
          role: "assistant",
          content: '"response"',
          created_at: "2024-01-17",
        },
      ]);

      const result = await getModelMessagesSince(new Date("2024-01-15T00:00:00Z"));

      expect(result).toHaveLength(2);
      expect((result[0]! as ModelMessage & { content: string }).content).toBe("after cutoff");
    });

    test("returns empty array on error", async () => {
      queryOneMock.mockRejectedValueOnce(new Error("timeout"));

      const result = await getModelMessagesSince(new Date());

      expect(result).toEqual([]);
    });

    test("passes ISO string to query", async () => {
      queryOneMock.mockResolvedValueOnce([]);

      const since = new Date("2024-06-15T12:30:00Z");
      await getModelMessagesSince(since);

      const [, params] = queryOneMock.mock.calls[0] as [
        string,
        { since: string },
      ];
      expect(params.since).toBe("2024-06-15T12:30:00.000Z");
    });
  });

  // -----------------------------------------------------------------------
  // getLastModelMessage
  // -----------------------------------------------------------------------

  describe("getLastModelMessage", () => {
    test("returns the most recent message", async () => {
      queryFirstMock.mockResolvedValueOnce({
        id: "m1",
        project: "p",
        role: "user",
        content: '"latest"',
        created_at: "2024-01-03",
      });

      const msg = await getLastModelMessage();

      expect(msg?.role).toBe("user");
      expect((msg as ModelMessage & { content: string })?.content).toBe("latest");
    });

    test("returns null when log is empty", async () => {
      queryFirstMock.mockResolvedValueOnce(null);

      const msg = await getLastModelMessage();

      expect(msg).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Compaction State (Global)
  // -----------------------------------------------------------------------

  describe("compaction state", () => {
    describe("getCompactionState", () => {
      test("returns global state when it exists", async () => {
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 50000,
          is_compacting: false,
          updated_at: "2024-01-01T00:00:00Z",
        });

        const state = await getCompactionState();

        expect(state?.tokens_since_last).toBe(50000);
        expect(state?.is_compacting).toBe(false);
      });

      test("returns null when no state exists", async () => {
        queryFirstMock.mockResolvedValueOnce(null);

        const state = await getCompactionState();

        expect(state).toBeNull();
      });
    });

    describe("updateTokenCount", () => {
      // Default config: maxTokens=262144, compactionThreshold=0.8
      // Threshold = 262144 * 0.8 = 209715.2

      test("creates state via INSERT IGNORE then increments atomically", async () => {
        // 1. getCompactionState returns null (no state yet)
        queryFirstMock.mockResolvedValueOnce(null);
        // 2. INSERT IGNORE (idempotent init)
        queryMock.mockResolvedValueOnce([[]]);
        // 3. UPDATE ... RETURN AFTER (atomic delta calculation)
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 5000,// 0 + delta(5000 - 0)
          is_compacting: false,
          last_prompt_tokens: 5000,
          updated_at: "2024-01-01",
        });

        const { state, needsCompaction } = await updateTokenCount(5000);

        expect(state.tokens_since_last).toBe(5000);
        expect(state.last_prompt_tokens).toBe(5000);
        expect(needsCompaction).toBe(false);
      });

      test("signals compaction when tokens exceed threshold", async () => {
        // 1. getCompactionState returns existing state
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 220000,
          is_compacting: false,
          last_prompt_tokens: 60000,
          updated_at: "2024-01-01",
        });
        // 2. UPDATE returns state with high token count
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 221000, // 220000 + delta(61000 - 60000)
          is_compacting: false,
          last_prompt_tokens: 61000,
          updated_at: "2024-01-01",
        });

        const { needsCompaction } = await updateTokenCount(61000);

        expect(needsCompaction).toBe(true);
      });

      test("does not signal compaction when already compacting", async () => {
        queryMock.mockResolvedValueOnce([[]]); // INSERT IGNORE
        // UPDATE returns state that's already compacting
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 221000,
          is_compacting: true,
          last_prompt_tokens: 61000,
          updated_at: "2024-01-01",
        });

        const { needsCompaction } = await updateTokenCount(61000);

        expect(needsCompaction).toBe(false);
      });

      test("returns fallback state when UPDATE returns nothing", async () => {
        queryMock.mockResolvedValueOnce([[]]); // INSERT IGNORE
        queryFirstMock.mockResolvedValueOnce(null); // UPDATE returns nothing

        const { state, needsCompaction } = await updateTokenCount(100);

        expect(needsCompaction).toBe(false);
        expect(state.id).toBe("compaction_state:global");
        expect(state.tokens_since_last).toBe(0);
      });

      test("computes delta correctly when prompt grows", async () => {
        // 1. getCompactionState returns existing state
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 100000,
          is_compacting: false,
          last_prompt_tokens: 60000,
          updated_at: "2024-01-01",
        });
        // 2. UPDATE returns updated state with delta applied
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 105000, // 100000 + (65000 - 60000)
          is_compacting: false,
          last_prompt_tokens: 65000,
          updated_at: "2024-01-01",
        });

        const { state } = await updateTokenCount(65000);

        // Delta = 65000 - 60000 = 5000 (calculated inside SQL)
        expect(state.tokens_since_last).toBe(105000);
        expect(state.last_prompt_tokens).toBe(65000);
      });

      test("uses full prompt when prompt shrank (after compaction)", async () => {
        // 1. getCompactionState returns state with higher last_prompt_tokens
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 0,
          is_compacting: false,
          last_prompt_tokens: 200000, // Previous prompt was 200k
          updated_at: "2024-01-01",
        });
        // 2. UPDATE returns state — prompt shrank so full prompt used as delta
        queryFirstMock.mockResolvedValueOnce({
          id: "compaction_state:global",
          tokens_since_last: 15000, // 0 + 15000 (full prompt, not delta)
          is_compacting: false,
          last_prompt_tokens: 15000,
          updated_at: "2024-01-01",
        });

        const { state } = await updateTokenCount(15000);

        // When prompt shrank, we use the full prompt as delta
        expect(state.tokens_since_last).toBe(15000);
        expect(state.last_prompt_tokens).toBe(15000);
      });
    });

    describe("startCompaction", () => {
      test("returns true when lock acquired", async () => {
        queryMock.mockResolvedValueOnce([[]]); // INSERT IGNORE
        queryOneMock.mockResolvedValueOnce([
          { id: "compaction_state:global", is_compacting: true },
        ]);

        const acquired = await startCompaction();

        expect(acquired).toBe(true);
      });

      test("returns false when already compacting", async () => {
        queryMock.mockResolvedValueOnce([[]]); // INSERT IGNORE
        queryOneMock.mockResolvedValueOnce([]); // WHERE is_compacting = false matched nothing

        const acquired = await startCompaction();

        expect(acquired).toBe(false);
      });
    });

    describe("finishCompaction", () => {
      test("issues reset query", async () => {
        queryMock.mockResolvedValueOnce([[]]);

        await finishCompaction();

        expect(queryMock).toHaveBeenCalledTimes(1);
        const [query] = queryMock.mock.calls[0] as [string];
        expect(query).toContain("tokens_since_last = 0");
        expect(query).toContain("is_compacting = false");
      });
    });
  });
});