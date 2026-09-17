import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseDelegateArgs, parseReviewPromptArgs } from "./delegate-command";

describe("parseDelegateArgs", () => {
  test("start requires --plan and resolves it", () => {
    expect(parseDelegateArgs(["start", "--plan", "docs/plan.md"])).toEqual({
      action: "start",
      planFile: resolve("docs/plan.md"),
    });
    expect(typeof parseDelegateArgs(["start"])).toBe("string");
  });

  test("status and stop take no arguments; anything else is usage", () => {
    expect(parseDelegateArgs(["status"])).toEqual({ action: "status" });
    expect(parseDelegateArgs(["stop"])).toEqual({ action: "stop" });
    expect(typeof parseDelegateArgs([])).toBe("string");
    expect(typeof parseDelegateArgs(["pause"])).toBe("string");
  });
});

describe("parseReviewPromptArgs", () => {
  test("worktree positional, optional title, flag order agnostic", () => {
    expect(parseReviewPromptArgs(["/wt"])).toEqual({
      worktree: "/wt",
      title: "Review this change",
    });
    expect(parseReviewPromptArgs(["--title", "Add shout", "/wt"])).toEqual({
      worktree: "/wt",
      title: "Add shout",
    });
    expect(parseReviewPromptArgs(["/wt", "--title", "Add shout"])).toEqual({
      worktree: "/wt",
      title: "Add shout",
    });
    expect(parseReviewPromptArgs(["--title", "only"])).toBeNull();
  });
});
