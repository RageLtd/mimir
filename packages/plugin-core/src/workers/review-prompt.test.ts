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
  test("title, cold-read instructions, diff and content — no plan", () => {
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
    expect(prompt).toContain("=== greet.ts\nline1\nline2");
    expect(prompt).toContain("=== gone.ts (deleted)");
    expect(prompt).not.toContain("plan file");
  });

  test("file content is truncated per file", () => {
    const after = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const prompt = buildReviewPrompt({
      title: "t",
      files: [file({ path: "a.ts", after })],
      maxLinesPerFile: 10,
    });
    expect(prompt).toContain("l9");
    expect(prompt).not.toContain("\nl10\n");
    expect(prompt).toContain("40 more lines truncated");
  });
});
