/**
 * Tests for the context-assembly trim helper.
 *
 * The route itself is integration-tested via the live mimir-acp ↔ server
 * boundary; this file unit-tests the pure budget logic so behaviour is
 * pinned down without spinning up the full route stack.
 */

import { describe, expect, it } from "bun:test";
import { trimByTokenBudget } from "./context";

const mk = (role: "user" | "assistant", content: string) => ({
  role,
  content,
});

describe("trimByTokenBudget", () => {
  it("returns input unchanged when budget is 0", () => {
    const input = [mk("user", "a"), mk("assistant", "b")];
    const { kept, tokensUsed, dropped } = trimByTokenBudget(input, 0);
    expect(kept).toEqual(input);
    expect(tokensUsed).toBe(0);
    expect(dropped).toBe(0);
  });

  it("returns empty kept set on empty input", () => {
    const { kept, tokensUsed, dropped } = trimByTokenBudget([], 1000);
    expect(kept).toEqual([]);
    expect(tokensUsed).toBe(0);
    expect(dropped).toBe(0);
  });

  it("keeps everything when total cost fits the budget", () => {
    const input = [
      mk("user", "hello"),
      mk("assistant", "world"),
      mk("user", "foo"),
    ];
    const { kept, dropped } = trimByTokenBudget(input, 100_000);
    expect(kept).toEqual(input);
    expect(dropped).toBe(0);
  });

  it("trims oldest messages when budget is tight", () => {
    // Each message is ~1 token; budget of 2 keeps the last two only.
    const input = [
      mk("user", "one"),
      mk("assistant", "two"),
      mk("user", "three"),
      mk("assistant", "four"),
    ];
    const { kept, dropped } = trimByTokenBudget(input, 2);
    expect(kept.length).toBe(2);
    expect(kept[0]?.content).toBe("three");
    expect(kept[1]?.content).toBe("four");
    expect(dropped).toBe(2);
  });

  it("preserves chronological order after trimming", () => {
    const input = [
      mk("user", "alpha"),
      mk("assistant", "beta"),
      mk("user", "gamma"),
    ];
    const { kept } = trimByTokenBudget(input, 2);
    // Reverse-walk + unshift must produce chronological output.
    for (let i = 1; i < kept.length; i++) {
      const prev = input.indexOf(kept[i - 1]!);
      const curr = input.indexOf(kept[i]!);
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it("always keeps the most recent message even if it exceeds the budget", () => {
    const giant = "tool result ".repeat(2000); // far above budget=1
    const input = [mk("user", "old"), mk("assistant", giant)];
    const { kept, dropped } = trimByTokenBudget(input, 1);
    expect(kept.length).toBe(1);
    expect(kept[0]?.content).toBe(giant);
    expect(dropped).toBe(1);
  });
});
