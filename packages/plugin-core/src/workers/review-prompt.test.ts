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
    // On Claude Code the reviewer starts in a worktree of its own, so
    // "the worktree you are in" sent it looking in the wrong place.
    expect(prompt).toContain(
      "Read the changed files from the worktree under review",
    );
    expect(prompt).not.toContain("worktree you are in");
    expect(prompt.indexOf("=== greet.ts")).toBeLessThan(
      prompt.indexOf("=== gone.ts"),
    );
  });
});

// The instructions block only: what the reviewer is told to look for, with
// the diff (which could contain any text) cut off.
const reviewTask = () => {
  const prompt = buildReviewPrompt({
    title: "Tidy greet",
    files: [file({ path: "greet.ts", added: "export const x = 1;" })],
  });
  const start = prompt.indexOf("<review_task>");
  const end = prompt.indexOf("</review_task>");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(end).toBeLessThan(prompt.indexOf("<diff>"));
  return prompt.slice(start, end);
};

describe("buildReviewPrompt — Mimir's rules", () => {
  // Pinned on a short phrase each, as the code principles are below.
  const lookFor: ReadonlyArray<readonly [string, RegExp]> = [
    ["work the problem does not require", /work the problem does not require/i],
    [
      "a guard, fallback or default for a state no caller produces",
      /state no caller produces/i,
    ],
    [
      "an interface shaped before the code that calls it",
      /before the code that calls it/i,
    ],
    [
      "a hierarchy where one function over the variants would do",
      /switching over the variants/i,
    ],
    ["a layer that only converts data", /only converts data/i],
    [
      "files changed that the task did not need",
      /files changed that the task did not need/i,
    ],
  ];

  for (const [idea, phrase] of lookFor) {
    test(`the reviewer is told to look for ${idea}`, () => {
      expect(reviewTask()).toMatch(phrase);
    });
  }

  test("code the task did not need is a should-fix, not one of three nits", () => {
    expect(reviewTask()).toMatch(
      /Should-fix:[^\n]*code the change added that the task did not need/,
    );
  });
});

describe("buildReviewPrompt — code principles", () => {
  test("the task tells the reviewer to check the change against the code principles", () => {
    expect(reviewTask()).toMatch(/code principles/i);
  });

  // Each idea is pinned on a short phrase, so a rewording that keeps the
  // idea passes and one that drops it fails.
  const lookFor: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
    [
      "a function that only forwards its arguments",
      [/forward(s|ing)? (its |the )?arguments/i],
    ],
    [
      "a one-caller helper that hides more than it explains",
      [/one caller/i, /hides more than it explains/i],
    ],
    [
      "an abstraction, option or parameter for a case the code does not have",
      [
        /abstraction/i,
        /parameter/i,
        /case(s)? the code (does not|doesn't|do not|don't) have/i,
      ],
    ],
    [
      "two cases merged behind a flag that only look alike",
      [/behind a flag/i, /(only )?look(s)? alike/i],
    ],
    [
      "code made shorter by cramming or dropping a check",
      [/shorter/i, /cramm/i, /drop(ping|s)? a check/i],
    ],
    [
      "a rename or move presented as a simplification",
      [/rename/i, /\bmove\b/i, /simplification/i],
    ],
  ];

  for (const [idea, patterns] of lookFor) {
    test(`it names: ${idea}`, () => {
      const task = reviewTask();
      for (const pattern of patterns) {
        expect(task).toMatch(pattern);
      }
    });
  }

  test("the existing bar for a finding is not loosened", () => {
    const task = reviewTask();
    // What makes a finding.
    expect(task).toMatch(/Report only what you can show/i);
    expect(task).toMatch(/trigger that can happen/i);
    expect(task).toMatch(/Check the trigger is real/i);
    // What to leave out.
    expect(task).toMatch(/Leave out/i);
    expect(task).toMatch(/later edits or deletes code/i);
    expect(task).toMatch(/environment the project does not run in/i);
    expect(task).toMatch(
      /missing test for behaviour another test already holds/i,
    );
    expect(task).toMatch(/no project rule requires/i);
    // How to say how you know.
    expect(task).toContain('"ran"');
    expect(task).toContain('"read"');
    expect(task).toMatch(/could not confirm is not a finding/i);
    expect(task).toContain("Unconfirmed");
    // Severity and the nit cap.
    expect(task).toMatch(/Order findings by severity/i);
    expect(task).toContain("Blocker:");
    expect(task).toContain("Should-fix:");
    expect(task).toContain("Nit:");
    expect(task).toMatch(/three at most/i);
    expect(task).toContain("No findings.");
    // Read-only, and the closing line.
    expect(task).toMatch(/Do not edit anything/i);
    expect(task).toMatch(/STATUS: done\s*$/);
  });

  test("the principles passage sits before the closing STATUS line", () => {
    const task = reviewTask();
    expect(task.search(/code principles/i)).toBeGreaterThanOrEqual(0);
    expect(task.search(/code principles/i)).toBeLessThan(
      task.indexOf("STATUS: done"),
    );
  });
});
