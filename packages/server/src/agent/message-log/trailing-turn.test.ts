/**
 * Tests for the single-brain write helpers:
 * extractTrailingTurn, appendTrailingTurn, getLastModelMessages.
 *
 * Kept in a separate file from message-log.test.ts — that file is already
 * near the file-length limit and the new helpers form a coherent subject
 * on their own.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import * as surreal from "../../db/surreal";
import {
  appendTrailingTurn,
  appendTurn,
  extractTrailingTurn,
  getLastModelMessages,
} from "./index";

describe("trailing-turn helpers", () => {
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

  // ---------------------------------------------------------------------
  // extractTrailingTurn
  // ---------------------------------------------------------------------

  describe("extractTrailingTurn", () => {
    test("picks up a single trailing user message", () => {
      const input: ModelMessage[] = [
        { role: "user", content: "a" },
        { role: "assistant", content: "x" },
        { role: "user", content: "b" },
      ];
      expect(extractTrailingTurn(input)).toEqual([
        { role: "user", content: "b" },
      ]);
    });

    test("picks up multiple trailing tool messages (parallel tool results)", () => {
      const input: ModelMessage[] = [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: "t",
              output: { type: "text", value: "r1" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "2",
              toolName: "t",
              output: { type: "text", value: "r2" },
            },
          ],
        },
      ];
      const result = extractTrailingTurn(input);
      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe("tool");
      expect(result[1]?.role).toBe("tool");
    });

    test("stops at assistant message (doesn't cross the boundary)", () => {
      const input: ModelMessage[] = [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ];
      const result = extractTrailingTurn(input);
      expect(result).toEqual([{ role: "user", content: "q2" }]);
    });

    test("returns empty array when the trailing message is assistant", () => {
      const input: ModelMessage[] = [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ];
      expect(extractTrailingTurn(input)).toEqual([]);
    });

    test("returns empty array for empty input", () => {
      expect(extractTrailingTurn([])).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // appendTrailingTurn
  // ---------------------------------------------------------------------

  describe("appendTrailingTurn", () => {
    test("no-ops when no trailing user/tool messages", async () => {
      const ids = await appendTrailingTurn(
        [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
        "p",
      );
      expect(ids).toEqual([]);
      // Nothing was inserted
      expect(queryMock).not.toHaveBeenCalled();
    });

    test("appends a new trailing user message when DB tail does not match", async () => {
      // DB tail returns some different message (simulates another client or
      // previous state)
      queryOneMock.mockResolvedValueOnce([
        {
          id: "id-1",
          project_id: "p",
          role: "user",
          content: '"something else"',
          created_at: "2024-01-01",
        },
      ]);
      // CREATE insert returns an id
      queryMock.mockResolvedValueOnce([
        [
          {
            id: "message_log:[p,1]",
            project_id: "p",
            role: "user",
            content: '"new"',
            created_at: "2024-01-02",
          },
        ],
      ]);

      const ids = await appendTrailingTurn(
        [
          { role: "user", content: "old" },
          { role: "assistant", content: "x" },
          { role: "user", content: "new" },
        ],
        "p",
      );

      expect(ids).toHaveLength(1);
      expect(ids[0]).toBe("message_log:[p,1]");
    });

    test("skips when DB tail matches trailing block (retry idempotency)", async () => {
      // DB tail returns the same single user message we're about to append
      queryOneMock.mockResolvedValueOnce([
        {
          id: "id-1",
          project_id: "p",
          role: "user",
          content: '"retry me"',
          created_at: "2024-01-01",
        },
      ]);

      const ids = await appendTrailingTurn(
        [
          { role: "user", content: "prior" },
          { role: "assistant", content: "x" },
          { role: "user", content: "retry me" },
        ],
        "p",
      );

      expect(ids).toEqual([]);
      // queryOne was called once for the tail lookup; queryMock
      // (the CREATE path) was never called.
      expect(queryOneMock).toHaveBeenCalledTimes(1);
      expect(queryMock).not.toHaveBeenCalled();
    });

    test("appends all trailing tool results in order", async () => {
      queryOneMock.mockResolvedValueOnce([]); // empty DB tail
      queryMock
        .mockResolvedValueOnce([
          [
            {
              id: "message_log:[p,1]",
              project_id: "p",
              role: "tool",
              content: "",
              created_at: "2024-01-02",
            },
          ],
        ])
        .mockResolvedValueOnce([
          [
            {
              id: "message_log:[p,2]",
              project_id: "p",
              role: "tool",
              content: "",
              created_at: "2024-01-02",
            },
          ],
        ]);

      const ids = await appendTrailingTurn(
        [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "1",
                toolName: "t",
                output: { type: "text", value: "r1" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "2",
                toolName: "t",
                output: { type: "text", value: "r2" },
              },
            ],
          },
        ],
        "p",
      );

      expect(ids).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------
  // appendTurn (CC persist path — known delta)
  // ---------------------------------------------------------------------

  describe("appendTurn", () => {
    test("appends a user+assistant pair in order", async () => {
      queryOneMock.mockResolvedValueOnce([]); // empty DB tail
      queryMock
        .mockResolvedValueOnce([
          [
            {
              id: "message_log:[p,1]",
              project_id: "p",
              role: "user",
              content: '"q"',
              created_at: "2024-01-02",
            },
          ],
        ])
        .mockResolvedValueOnce([
          [
            {
              id: "message_log:[p,2]",
              project_id: "p",
              role: "assistant",
              content: '"a"',
              created_at: "2024-01-02",
            },
          ],
        ]);

      const ids = await appendTurn(
        [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
        "p",
      );

      expect(ids).toHaveLength(2);
    });

    test("skips when DB tail matches the delta (retry idempotency)", async () => {
      // Query returns DESC order (newest first); helper reverses to
      // chronological [user, assistant] for fingerprint comparison.
      queryOneMock.mockResolvedValueOnce([
        {
          id: "m2",
          project_id: "p",
          role: "assistant",
          content: '"a"',
          created_at: "2024-01-02",
        },
        {
          id: "m1",
          project_id: "p",
          role: "user",
          content: '"q"',
          created_at: "2024-01-01",
        },
      ]);

      const ids = await appendTurn(
        [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
        "p",
      );

      expect(ids).toEqual([]);
      expect(queryMock).not.toHaveBeenCalled();
    });

    test("no-op for empty input", async () => {
      const ids = await appendTurn([], "p");
      expect(ids).toEqual([]);
      expect(queryOneMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // getLastModelMessages
  // ---------------------------------------------------------------------

  describe("getLastModelMessages", () => {
    test("returns the last N in chronological order", async () => {
      // Query returns DESC order; helper reverses to chronological.
      queryOneMock.mockResolvedValueOnce([
        {
          id: "m3",
          project_id: "p",
          role: "user",
          content: '"third"',
          created_at: "2024-01-03",
        },
        {
          id: "m2",
          project_id: "p",
          role: "user",
          content: '"second"',
          created_at: "2024-01-02",
        },
        {
          id: "m1",
          project_id: "p",
          role: "user",
          content: '"first"',
          created_at: "2024-01-01",
        },
      ]);

      const result = await getLastModelMessages(3);

      expect(result).toHaveLength(3);
      expect((result[0] as ModelMessage & { content: string }).content).toBe(
        "first",
      );
      expect((result[1] as ModelMessage & { content: string }).content).toBe(
        "second",
      );
      expect((result[2] as ModelMessage & { content: string }).content).toBe(
        "third",
      );
    });

    test("returns empty array when log is empty", async () => {
      queryOneMock.mockResolvedValueOnce([]);
      const result = await getLastModelMessages(50);
      expect(result).toEqual([]);
    });
  });
});
