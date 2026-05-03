import { beforeEach, describe, expect, test } from "bun:test";
import {
  getContextWindow,
  resetContextWindowCacheForTests,
  setContextWindow,
} from "./context-window-cache";

describe("context-window-cache", () => {
  beforeEach(() => {
    resetContextWindowCacheForTests();
  });

  test("getContextWindow returns undefined before any population", () => {
    expect(getContextWindow("claude-code/opus")).toBeUndefined();
  });

  test("setContextWindow stores a value retrievable by the same key", () => {
    setContextWindow("claude-code/opus", 200_000);
    expect(getContextWindow("claude-code/opus")).toBe(200_000);
  });

  test("setContextWindow overwrites a prior value for the same key", () => {
    setContextWindow("claude-code/sonnet", 200_000);
    setContextWindow("claude-code/sonnet", 1_000_000);
    expect(getContextWindow("claude-code/sonnet")).toBe(1_000_000);
  });

  test("entries are independent across model ids", () => {
    setContextWindow("claude-code/opus", 200_000);
    setContextWindow("claude-code/sonnet[1m]", 1_000_000);
    expect(getContextWindow("claude-code/opus")).toBe(200_000);
    expect(getContextWindow("claude-code/sonnet[1m]")).toBe(1_000_000);
  });

  test("getContextWindow returns undefined for unknown ids even when cache is populated", () => {
    setContextWindow("claude-code/opus", 200_000);
    expect(getContextWindow("claude-code/haiku")).toBeUndefined();
  });

  test("setContextWindow ignores non-positive sizes", () => {
    setContextWindow("claude-code/opus", 0);
    setContextWindow("claude-code/opus", -1);
    expect(getContextWindow("claude-code/opus")).toBeUndefined();
  });

  test("resetContextWindowCacheForTests clears all entries", () => {
    setContextWindow("claude-code/opus", 200_000);
    setContextWindow("claude-code/sonnet", 1_000_000);
    resetContextWindowCacheForTests();
    expect(getContextWindow("claude-code/opus")).toBeUndefined();
    expect(getContextWindow("claude-code/sonnet")).toBeUndefined();
  });
});
