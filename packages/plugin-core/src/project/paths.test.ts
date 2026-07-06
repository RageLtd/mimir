/**
 * Tests for toProjectRelative — the path normaliser applied at every seam
 * where file paths cross the plugin/server boundary.
 */

import { describe, expect, test } from "bun:test";

import { toProjectRelative } from "./paths";

describe("toProjectRelative", () => {
  test("collapses an absolute path inside the project root to relative", () => {
    expect(toProjectRelative("/repo", "/repo/src/result.ts")).toBe(
      "src/result.ts",
    );
  });

  test("returns ../foo form for an absolute path outside the project root", () => {
    expect(toProjectRelative("/repo", "/other/file.ts")).toBe(
      "../other/file.ts",
    );
  });

  test("passes an already-relative path through unchanged", () => {
    expect(toProjectRelative("/repo", "src/result.ts")).toBe("src/result.ts");
  });

  test("returns empty string when path equals the root", () => {
    expect(toProjectRelative("/repo", "/repo")).toBe("");
  });

  test("handles nested directories correctly", () => {
    expect(toProjectRelative("/repo", "/repo/src/project/paths.ts")).toBe(
      "src/project/paths.ts",
    );
  });
});
