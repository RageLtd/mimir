import { describe, expect, test } from "bun:test";
import { projectRelativeReadPath } from "./file-context-hook";

const ROOT = "/work/repo";
const DRIFTED_CWD = "/work/repo/packages/x";
const NESTED = "packages/x/a.ts";

describe("projectRelativeReadPath", () => {
  test("resolves a relative path against a drifted cwd", () => {
    expect(projectRelativeReadPath(DRIFTED_CWD, ROOT, "a.ts")).toBe(NESTED);
  });

  test("resolves a dot-relative path against a drifted cwd", () => {
    expect(projectRelativeReadPath(DRIFTED_CWD, ROOT, "./src/b.ts")).toBe(
      "packages/x/src/b.ts",
    );
  });

  test("keeps a relative path when cwd is the root", () => {
    expect(projectRelativeReadPath(ROOT, ROOT, NESTED)).toBe(NESTED);
  });

  test("an absolute path wins over the cwd", () => {
    expect(
      projectRelativeReadPath(DRIFTED_CWD, ROOT, "/work/repo/packages/y/c.ts"),
    ).toBe("packages/y/c.ts");
  });

  test("returns null for a relative path that escapes the root", () => {
    expect(
      projectRelativeReadPath(DRIFTED_CWD, ROOT, "../../../etc/passwd"),
    ).toBeNull();
  });

  test("returns null for an absolute path outside the root", () => {
    expect(
      projectRelativeReadPath(ROOT, ROOT, "/private/tmp/scratch/notes.txt"),
    ).toBeNull();
  });
});
