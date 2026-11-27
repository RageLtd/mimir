/**
 * The role-boundary note: when a failed command names only files the
 * worker's role may not edit, the block says so. Pure — the existence of
 * named files is a predicate over worktree-relative paths, so no git
 * repository and no file system is needed.
 */

import { describe, expect, test } from "bun:test";
import { roleBoundaryNote } from "./role-boundary";

const WORKTREE = "/work/tree";
/** The package root the toolchain command ran in. */
const ROOT = `${WORKTREE}/packages/core`;

const IMPL_FILE = "packages/core/src/parse.ts";
const OTHER_IMPL_FILE = "packages/core/src/render.ts";
const TEST_FILE = "packages/core/src/parse.test.ts";

const existing = (...paths: string[]) => {
  const set = new Set(paths);
  return (path: string) => set.has(path);
};

const ALL_FILES = existing(IMPL_FILE, OTHER_IMPL_FILE, TEST_FILE);

const BLOCKED = "STATUS: blocked";

/** The note's condition: stop only when the worker's own change cannot fix it. */
const CONDITION_NEAR_BLOCKED =
  /own (change|edit)s?[\s\S]{0,160}STATUS: blocked|STATUS: blocked[\s\S]{0,160}own (change|edit)s?/i;

const TEST_FILE_TYPE_ERROR = `${ROOT}/src/parse.test.ts(14,7): error TS2554: Expected 1 arguments, but got 2.\n`;

describe("roleBoundaryNote", () => {
  test("a test worker whose check fails only in implementation files is told to stop blocked and name mimir-impl", () => {
    const note = roleBoundaryNote({
      kind: "check",
      role: "test",
      output: [
        "Checked 12 files.",
        "src/parse.ts:3:5 lint/style/useConst  FIXABLE",
        "  × This let declares a variable that is only assigned once.",
        "src/render.ts:10:1 format  ━━━━━━━━━━",
        "Found 2 errors.",
      ].join("\n"),
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).not.toBeNull();
    expect(note).toContain(IMPL_FILE);
    expect(note).toContain(OTHER_IMPL_FILE);
    expect(note).toMatch(/outside/i);
    expect(note).toContain(BLOCKED);
    expect(note).toContain("mimir-impl");
  });

  test("an implementation worker whose typecheck fails only in test files is told to stop blocked and name mimir-test", () => {
    const note = roleBoundaryNote({
      kind: "typecheck",
      role: "impl",
      output: `${ROOT}/src/parse.test.ts(14,7): error TS2554: Expected 1 arguments, but got 2.\n`,
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).not.toBeNull();
    expect(note).toContain(TEST_FILE);
    expect(note).toMatch(/outside/i);
    expect(note).toContain(BLOCKED);
    expect(note).toContain("mimir-test");
  });

  test("a vet failing only outside the worker's role gets the note", () => {
    const note = roleBoundaryNote({
      kind: "vet",
      role: "impl",
      output: "warning: needless clone\n --> src/parse.test.ts:8:12\n",
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).toContain(TEST_FILE);
    expect(note).toContain(BLOCKED);
  });

  test("paths relative to the command's directory and absolute paths, with either position form, are both recognised", () => {
    const note = roleBoundaryNote({
      kind: "check",
      role: "test",
      output: [
        "src/parse.ts(3,5): error: unexpected token",
        `${ROOT}/src/render.ts:10:1: error: unused import`,
      ].join("\n"),
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).toContain(IMPL_FILE);
    expect(note).toContain(OTHER_IMPL_FILE);
  });

  test("no note when the output names at least one file the worker's role may edit", () => {
    const note = roleBoundaryNote({
      kind: "check",
      role: "test",
      output: [
        "src/parse.ts:3:5 lint/style/useConst",
        "src/parse.test.ts:9:2 lint/suspicious/noExplicitAny",
      ].join("\n"),
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).toBeNull();
  });

  test("no note when the output names no file that exists in the worktree", () => {
    const note = roleBoundaryNote({
      kind: "typecheck",
      role: "impl",
      output: "src/ghost.test.ts(1,1): error TS2307: Cannot find module.\n",
      cwd: ROOT,
      worktree: WORKTREE,
      exists: existing(IMPL_FILE),
    });
    expect(note).toBeNull();
  });

  test("for either role, the note says to stop blocked only if the worker's own change cannot clear the failure", () => {
    const notes = [
      roleBoundaryNote({
        kind: "check",
        role: "test",
        output: "src/parse.ts:3:5 lint/correctness/noUnusedVariables\n",
        cwd: ROOT,
        worktree: WORKTREE,
        exists: ALL_FILES,
      }),
      roleBoundaryNote({
        kind: "typecheck",
        role: "impl",
        output: TEST_FILE_TYPE_ERROR,
        cwd: ROOT,
        worktree: WORKTREE,
        exists: ALL_FILES,
      }),
    ];
    for (const note of notes) {
      expect(note).toContain(BLOCKED);
      expect(note).toMatch(CONDITION_NEAR_BLOCKED);
      expect(note).not.toMatch(/do not edit them/i);
    }
  });

  test("an implementation worker is told the failure may come from its own implementation, such as a missing or mismatched export, and to check that first", () => {
    const note = roleBoundaryNote({
      kind: "typecheck",
      role: "impl",
      output: TEST_FILE_TYPE_ERROR,
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).toMatch(/own implementation/i);
    expect(note).toMatch(/export/i);
    expect(note).toMatch(/first/i);
  });

  test("a failed test command never gets the note, whatever its output names", () => {
    const note = roleBoundaryNote({
      kind: "test",
      role: "impl",
      output: `${ROOT}/src/parse.test.ts:14:7: expect(received).toBe(expected)\n`,
      cwd: ROOT,
      worktree: WORKTREE,
      exists: ALL_FILES,
    });
    expect(note).toBeNull();
  });
});
