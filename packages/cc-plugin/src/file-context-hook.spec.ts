import { describe, expect, test } from "bun:test";

import { countMemories } from "./file-context-hook";

describe("countMemories", () => {
  test("prefers the server's memoryCount when present", () => {
    expect(
      countMemories({ memoryCount: 3, memories: "- a\nline two\n- b" }),
    ).toBe(3);
  });

  test("memoryCount of 0 wins over a non-empty memories string", () => {
    expect(countMemories({ memoryCount: 0, memories: "- stale" })).toBe(0);
  });

  test("older servers: counts top-level bullets, not lines", () => {
    // Two memories, one with a multi-line body — the old line count
    // reported 13/23/36 "memories" for 3-memory payloads.
    const memories =
      "- first memory\ncontinuation line one\ncontinuation line two\n- second memory";
    expect(countMemories({ memories })).toBe(2);
  });

  test("no memories at all is zero", () => {
    expect(countMemories({})).toBe(0);
    expect(countMemories({ memories: null })).toBe(0);
    expect(countMemories({ memories: "" })).toBe(0);
  });
});
