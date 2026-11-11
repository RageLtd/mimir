/**
 * Tests for toProjectRelative — the path normaliser applied at every seam
 * where file paths cross the plugin/server boundary.
 */

import { describe, expect, test } from "bun:test";

import { isInsideProject, toProjectRelative } from "./paths";

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

describe("isInsideProject", () => {
  const ROOT = "/work/repo";

  test("accepts an absolute path inside the root", () => {
    expect(isInsideProject(ROOT, "/work/repo/packages/x/a.ts")).toBe(true);
  });

  test("accepts a relative path, resolved against the root", () => {
    expect(isInsideProject(ROOT, "packages/x/a.ts")).toBe(true);
  });

  test("accepts the root itself", () => {
    expect(isInsideProject(ROOT, ROOT)).toBe(true);
  });

  test("rejects a sibling that shares the root as a string prefix", () => {
    expect(isInsideProject(ROOT, "/work/repo-other/a.ts")).toBe(false);
  });

  test("rejects a path that escapes the root through ..", () => {
    expect(isInsideProject(ROOT, "/work/repo/../etc/x")).toBe(false);
  });

  test("accepts a file at the root whose name starts with two dots", () => {
    expect(isInsideProject(ROOT, "/work/repo/..hidden")).toBe(true);
  });
});
