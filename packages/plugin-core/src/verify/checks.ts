/**
 * Mechanical checks over a change set — pure functions of the diff.
 *
 *   coverage — source changed with no test added or changed → block
 *   sanity   — skips/focus added, assertions lost, a new test file with
 *              no assertions, a deleted test file → block
 *   counts   — test functions before → after, for the report
 *
 * "Test added" is a path match OR an added test marker in the diff
 * content, because Rust tests live inline under `#[cfg(test)]`. A test
 * file the integration branch already committed (red-first, before the
 * impl worker started) counts for coverage too — that is the playbook's
 * normal shape, not an exception.
 */

import {
  conventionFor,
  isTestFile,
  testSignals,
} from "../rules/test-conventions";
import type { ChangedFile } from "./changes";

export type CheckFailure = {
  readonly check: "coverage" | "refactor" | "sanity";
  readonly reason: string;
};

const isKnownLanguage = (path: string) => conventionFor(path) !== null;

const isSource = (file: ChangedFile) =>
  isKnownLanguage(file.path) && !isTestFile(file.path) && file.status !== "D";

/** Tests introduced by this file's change — by path or by content. */
const addsTests = (file: ChangedFile) => {
  if (file.status === "D") return false;
  if (isTestFile(file.path)) return true;
  return (testSignals(file.path, file.added)?.tests ?? 0) > 0;
};

export const coverageCheck = (
  files: readonly ChangedFile[],
  branchPaths: readonly string[] = [],
) => {
  const source = files.filter(isSource);
  if (source.length === 0) return null;
  if (files.some(addsTests) || branchPaths.some(isTestFile)) return null;
  return {
    check: "coverage",
    reason: `No test coverage for the change. Source changed with no test added or modified: ${source.map((f) => f.path).join(", ")}. Add or update tests that exercise this change (a failing test first, then the fix).`,
  } satisfies CheckFailure;
};

const declaresTests = (path: string, text: string | null) =>
  text !== null && (testSignals(path, text)?.tests ?? 0) > 0;

const touchesTests = (path: string, lines: string) => {
  const signals = testSignals(path, lines);
  return (signals?.tests ?? 0) + (signals?.assertions ?? 0) > 0;
};

/**
 * A test file by path, or a source file with inline tests (Rust's
 * `#[cfg(test)]`) whose changed lines carry a test or an assertion.
 * Kept that narrow because assertion patterns also match production
 * code, and a file that declares no test is never a changed test.
 */
const changesTests = (file: ChangedFile) =>
  isTestFile(file.path) ||
  ((declaresTests(file.path, file.before) ||
    declaresTests(file.path, file.after)) &&
    (touchesTests(file.path, file.added) ||
      touchesTests(file.path, file.removed)));

/**
 * A refactor keeps behaviour, so the existing suite is its contract: any
 * test changed since the task base blocks, whoever changed it.
 */
export const refactorCheck = (files: readonly ChangedFile[]) => {
  const tests = files.filter(changesTests);
  if (tests.length === 0) return null;
  return {
    check: "refactor",
    reason: `A refactor task may not change tests — the existing suite is the contract it keeps. Tests changed since the task base: ${tests.map((f) => f.path).join(", ")}. Revert them, or stop with STATUS: question if the task is not a refactor.`,
  } satisfies CheckFailure;
};

/** Net assertions this file's diff removed; 0 when it lost none. */
const assertionsLost = (file: ChangedFile) => {
  const added = testSignals(file.path, file.added);
  const removed = testSignals(file.path, file.removed);
  if (!added || !removed) return 0;
  return Math.max(0, removed.assertions - added.assertions);
};

/**
 * `allowedDeletions` names deleted test files the coordinator accepts
 * (tests folded into another file). It excuses only the deletion of that
 * exact path — never a problem in a file that is still there.
 *
 * `allowedRemovals` names test files the coordinator lets lose
 * assertions (the tests of a feature the task deletes). It excuses only
 * that net loss: a skip still blocks, and so does an allowed file that
 * gains more test functions than it loses while adding no assertion.
 */
export const sanityCheck = (
  files: readonly ChangedFile[],
  allowedDeletions: readonly string[] = [],
  allowedRemovals: readonly string[] = [],
) => {
  const problems: string[] = [];
  for (const file of files) {
    if (!isKnownLanguage(file.path)) continue;
    const testy = isTestFile(file.path) || addsTests(file);
    if (!testy) continue;

    if (file.status === "D") {
      if (allowedDeletions.includes(file.path)) continue;
      problems.push(
        `${file.path}: test file deleted — if it was moved rather than deleted, stage the move (\`git mv\`, or \`git add\` both paths) so the gate can pair it, and keep it at a test path. If its tests were folded into another test file, stop with STATUS: question and name the deleted files, so the coordinator can allow them.`,
      );
      continue;
    }
    const added = testSignals(file.path, file.added);
    const removed = testSignals(file.path, file.removed);
    if (!added || !removed) continue;

    if (added.skips > 0) {
      problems.push(
        `${file.path}: ${added.skips} skip/focus/ignore marker(s) added — tests must run, not be skipped`,
      );
    }
    const removalAllowed = allowedRemovals.includes(file.path);
    const lost = assertionsLost(file);
    if (lost > 0 && !removalAllowed) {
      problems.push(
        `${file.path}: assertions removed (−${lost} net) — weakening tests is not a fix. The count is a line heuristic: assertions moved into a shared helper count as removed too. If the assertions moved into a shared helper, or the task deletes what these tests covered, stop with STATUS: question and name the test files, so the coordinator can allow the removal.`,
      );
    }
    const gainsTests =
      file.status === "A"
        ? added.tests > 0
        : removalAllowed && added.tests > removed.tests;
    if (gainsTests && added.assertions === 0) {
      problems.push(
        `${file.path}: new tests with no assertions — a test that cannot fail proves nothing`,
      );
    }
  }
  if (problems.length === 0) return null;
  return {
    check: "sanity",
    reason: `Test changes look wrong:\n- ${problems.join("\n- ")}`,
  } satisfies CheckFailure;
};

export type TestCounts = { readonly before: number; readonly after: number };

/** Test-function counts across the changed files, before → after. */
export const testCounts = (files: readonly ChangedFile[]) => {
  let before = 0;
  let after = 0;
  for (const file of files) {
    if (!isKnownLanguage(file.path)) continue;
    before += file.before
      ? (testSignals(file.path, file.before)?.tests ?? 0)
      : 0;
    after += file.after ? (testSignals(file.path, file.after)?.tests ?? 0) : 0;
  }
  return { before, after } satisfies TestCounts;
};

export type TestTally = { readonly tests: number; readonly assertions: number };

const tally = (files: readonly ChangedFile[], side: "before" | "after") => {
  let tests = 0;
  let assertions = 0;
  for (const file of files) {
    const text = file[side];
    const signals = text ? testSignals(file.path, text) : null;
    tests += signals?.tests ?? 0;
    assertions += signals?.assertions ?? 0;
  }
  return { tests, assertions } satisfies TestTally;
};

/**
 * What a fold cost: the allowed deleted test files' tests and assertions
 * beside those of every other test file the change adds or changes,
 * before and after. Null when no allowed test-file deletion is in the
 * change set.
 */
export const allowedDeletionCost = (
  files: readonly ChangedFile[],
  allowedDeletions: readonly string[],
) => {
  const tests = files.filter((f) => isTestFile(f.path));
  const deleted = tests.filter(
    (f) => f.status === "D" && allowedDeletions.includes(f.path),
  );
  if (deleted.length === 0) return null;
  const others = tests.filter((f) => f.status !== "D");
  return {
    paths: deleted.map((f) => f.path),
    deleted: tally(deleted, "before"),
    othersBefore: tally(others, "before"),
    othersAfter: tally(others, "after"),
  };
};

export type AllowedDeletionCost = NonNullable<
  ReturnType<typeof allowedDeletionCost>
>;

/**
 * Each allowed test file whose assertion loss the allowance excused,
 * with its own tests and assertions before and after.
 */
export const allowedRemovalCost = (
  files: readonly ChangedFile[],
  allowedRemovals: readonly string[],
) =>
  files
    .filter(
      (f) =>
        f.status !== "D" &&
        isTestFile(f.path) &&
        allowedRemovals.includes(f.path) &&
        assertionsLost(f) > 0,
    )
    .map((f) => ({
      path: f.path,
      before: tally([f], "before"),
      after: tally([f], "after"),
    }));

export type AllowedRemovalCost = ReturnType<typeof allowedRemovalCost>;

/** Paths the toolchain must be resolved for: everything still on disk. */
export const verifiablePaths = (files: readonly ChangedFile[]) =>
  files.filter((f) => f.status !== "D").map((f) => f.path);
