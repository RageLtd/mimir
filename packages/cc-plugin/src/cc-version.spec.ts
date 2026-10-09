import { describe, expect, test } from "bun:test";
import {
  checkClaudeVersion,
  isAtLeast,
  MIN_CLAUDE_CODE_VERSION,
  parseVersion,
} from "./cc-version";

describe("parseVersion", () => {
  test("reads the triple out of `claude --version` output", () => {
    expect(parseVersion("2.1.294 (Claude Code)\n")).toEqual([2, 1, 294]);
  });

  test("returns null when no triple is present", () => {
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("isAtLeast", () => {
  test("compares numerically, not lexically", () => {
    expect(isAtLeast("2.1.300", "2.1.294")).toBe(true);
    expect(isAtLeast("2.1.29", "2.1.294")).toBe(false);
    expect(isAtLeast("2.2.0", "2.1.294")).toBe(true);
    expect(isAtLeast("1.9.999", "2.1.294")).toBe(false);
  });

  test("the minimum itself passes", () => {
    expect(isAtLeast(MIN_CLAUDE_CODE_VERSION, MIN_CLAUDE_CODE_VERSION)).toBe(
      true,
    );
  });
});

describe("checkClaudeVersion", () => {
  test("ok at or above the minimum", async () => {
    const result = await checkClaudeVersion(
      async () => "2.1.294 (Claude Code)",
      "2.1.294",
    );
    expect(result).toEqual({ kind: "ok", version: "2.1.294" });
  });

  test("too-old below the minimum, naming what was found", async () => {
    const result = await checkClaudeVersion(
      async () => "2.1.100 (Claude Code)",
      "2.1.294",
    );
    expect(result).toEqual({ kind: "too-old", version: "2.1.100" });
  });

  test("missing when claude cannot be run or prints no version", async () => {
    expect(await checkClaudeVersion(async () => null)).toEqual({
      kind: "missing",
    });
    expect(await checkClaudeVersion(async () => "garbage")).toEqual({
      kind: "missing",
    });
  });
});
