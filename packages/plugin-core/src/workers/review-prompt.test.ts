import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../verify/changes";
import { buildReviewPrompt } from "./review-prompt";

const file = (
  overrides: Partial<ChangedFile> & { path: string },
): ChangedFile => ({
  status: "M",
  added: "",
  removed: "",
  before: "",
  after: "",
  ...overrides,
});

describe("buildReviewPrompt", () => {
  test("title, cold-read instructions and diff — no plan, no file bodies", () => {
    const prompt = buildReviewPrompt({
      title: "Add shout()",
      files: [
        file({
          path: "greet.ts",
          added: "export const shout = () => 1;",
          removed: "const old = 0;",
          after: "line1\nline2",
        }),
        file({ path: "gone.ts", status: "D", after: null }),
      ],
    });
    expect(prompt).toContain("Title: Add shout()");
    expect(prompt).toContain("reviewing a change cold");
    expect(prompt).toContain("STATUS: done");
    expect(prompt).toContain("=== greet.ts (M)");
    expect(prompt).toContain("- const old = 0;");
    expect(prompt).toContain("+ export const shout = () => 1;");
    expect(prompt).toContain("=== gone.ts (D)");
    expect(prompt).not.toContain("plan file");
    // The reviewer reads files from the worktree itself; inlining them
    // only made the coordinator relay unchanged content.
    expect(prompt).not.toContain("<files>");
    expect(prompt).not.toContain("line1\nline2");
    expect(prompt).toContain("Read the changed files from the worktree");
    expect(prompt.indexOf("=== greet.ts")).toBeLessThan(
      prompt.indexOf("=== gone.ts"),
    );
  });
});
