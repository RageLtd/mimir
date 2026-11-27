/**
 * Test files folded into one: the coordinator names the deleted test
 * files it accepts (`allowedDeletions`), the gate accepts those and no
 * others, and its pass report shows what the fold cost. The change set is
 * handed in and toolchain commands are scripted, so no command runs.
 */

import { describe, expect, test } from "bun:test";
import {
  changed,
  changeSet,
  fixedChanges,
  gateSandbox,
  toolchain,
} from "./change-fixtures.test-helpers";
import type { ChangedFile } from "./changes";
import { runVerify } from "./verify";

const GO = { "go.mod": "module x\n" };
const ADD_TEST = "add_test.go";
const SUB_TEST = "sub_test.go";
const FOLDED = "math_test.go";
const NOTES = "NOTES.md";
const ALLOWED_HEADER = "Allowed test deletions";
const ALLOWED_TOTALS = "Allowed deleted test files";
const OTHER_TOTALS = "Other changed test files";

/** A Go test function with one assertion line per check. */
const goTest = (name: string, checks: readonly string[]) =>
  [
    `func ${name}(t *testing.T) {`,
    ...checks.map((c) => `\tif ${c} {\n\t\tt.Fatal("${name}")\n\t}`),
    "}",
  ].join("\n");

const goFile = (...tests: string[]) =>
  ["package x", 'import "testing"', ...tests, ""].join("\n");

const TEST_ADD = goTest("TestAdd", ["Add(1, 2) != 3", "Add(2, 2) != 4"]);
const TEST_ADD_ZERO = goTest("TestAddZero", ["Add(0, 0) != 0"]);
const TEST_SUB = goTest("TestSub", ["Sub(3, 1) != 2"]);

/**
 * Before the change: two test files holding 3 test functions and 4
 * assertions — add_test.go (TestAdd: 2, TestAddZero: 1), sub_test.go
 * (TestSub: 1).
 */
const ADD_TEST_BEFORE = goFile(TEST_ADD, TEST_ADD_ZERO);
const SUB_TEST_BEFORE = goFile(TEST_SUB);

/** The folded file: 2 test functions and 3 assertions. */
const FOLDED_TESTS = goFile(
  goTest("TestMathAdd", ["Add(1, 2) != 3", "Add(0, 0) != 0"]),
  goTest("TestMathSub", ["Sub(3, 1) != 2"]),
);

/** Both test files folded into a new math_test.go. */
const FOLD = [
  changed(FOLDED, null, FOLDED_TESTS),
  changed(ADD_TEST, ADD_TEST_BEFORE, null),
  changed(SUB_TEST, SUB_TEST_BEFORE, null),
];

const { project } = gateSandbox();

const verify = async (
  files: readonly ChangedFile[],
  agentId: string,
  allowed?: readonly string[],
) =>
  runVerify({
    worktree: await project(GO),
    lastMessage: "STATUS: done",
    agentId,
    changes: fixedChanges(changeSet(files)),
    run: toolchain(),
    allowedDeletions: allowed,
  });

/** The indented lines under the allowed-deletions header. */
const allowedSection = (report: string) => {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.startsWith(ALLOWED_HEADER));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith("  "));
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim());
};

describe("verify gate: allowed test-file deletions", () => {
  test("without an allowance, folding two test files blocks on both deletions with the fold advice", async () => {
    const outcome = await verify(FOLD, "fold-none");
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${ADD_TEST}: test file deleted`);
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
    expect(outcome.reason).toMatch(/git (add|mv)/);
    expect(outcome.reason).toContain("STATUS: question");
  });

  test("allowing only one of the deletions still blocks on the other", async () => {
    const outcome = await verify(FOLD, "fold-one", [ADD_TEST]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
    expect(outcome.reason).not.toContain(`${ADD_TEST}: test file deleted`);
  });

  test("an allowance for a path the change did not delete allows nothing", async () => {
    const outcome = await verify(FOLD, "fold-wrong", ["other_test.go", FOLDED]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${ADD_TEST}: test file deleted`);
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
  });

  test("both deletions allowed → pass, and the report shows what the fold cost", async () => {
    const outcome = await verify(FOLD, "fold-all", [ADD_TEST, SUB_TEST]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${ALLOWED_HEADER} (2):`);
    expect(allowedSection(report).sort()).toEqual([ADD_TEST, SUB_TEST]);
    expect(report).toContain(
      `${ALLOWED_TOTALS}: 3 test functions, 4 assertions`,
    );
    // The folded file is new, so its before side is 0.
    expect(report).toContain(
      `${OTHER_TOTALS}: 0 → 2 test functions, 0 → 3 assertions`,
    );
    // The existing lines stay as they are.
    expect(report).toContain("Test functions: 3 → 2");
    expect(report).toContain(`D ${ADD_TEST}`);
    expect(report).toContain(`A ${FOLDED}`);
  });

  test("folding a deleted test file into an existing one shows that file's counts rising", async () => {
    // TestSub moves into add_test.go, which already held 2 test functions
    // and 3 assertions; add_test.go is changed, not added.
    const outcome = await verify(
      [
        changed(
          ADD_TEST,
          ADD_TEST_BEFORE,
          goFile(TEST_ADD, TEST_ADD_ZERO, TEST_SUB),
        ),
        changed(SUB_TEST, SUB_TEST_BEFORE, null),
      ],
      "fold-existing",
      [SUB_TEST],
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${ALLOWED_HEADER} (1):`);
    expect(allowedSection(report)).toEqual([SUB_TEST]);
    expect(report).toContain(
      `${ALLOWED_TOTALS}: 1 test functions, 1 assertions`,
    );
    expect(report).toContain(
      `${OTHER_TOTALS}: 2 → 3 test functions, 3 → 4 assertions`,
    );
  });

  test("an allowed path that was deleted but is not a test file is neither listed nor counted", async () => {
    const outcome = await verify(
      [...FOLD, changed(NOTES, "notes\n", null)],
      "fold-notes",
      [ADD_TEST, SUB_TEST, NOTES],
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${ALLOWED_HEADER} (2):`);
    expect(allowedSection(report).sort()).toEqual([ADD_TEST, SUB_TEST]);
    expect(report).toContain(
      `${ALLOWED_TOTALS}: 3 test functions, 4 assertions`,
    );
    expect(report).toContain(
      `${OTHER_TOTALS}: 0 → 2 test functions, 0 → 3 assertions`,
    );
  });

  test("an allowed deletion does not excuse a skip added in the folded file", async () => {
    const outcome = await verify(
      [
        changed(
          FOLDED,
          null,
          goFile(
            goTest("TestMathAdd", ["Add(1, 2) != 3", "Add(0, 0) != 0"]),
            'func TestMathSub(t *testing.T) {\n\tt.Skip("later")\n\tif Sub(3, 1) != 2 {\n\t\tt.Fatal("sub")\n\t}\n}',
          ),
        ),
        changed(ADD_TEST, ADD_TEST_BEFORE, null),
        changed(SUB_TEST, SUB_TEST_BEFORE, null),
      ],
      "fold-skip",
      [ADD_TEST, SUB_TEST],
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") expect(outcome.reason).toContain("skip");
  });

  test("with no allowance, a pass report carries no allowed-deletions lines", async () => {
    const outcome = await verify(
      [
        changed(
          SUB_TEST,
          SUB_TEST_BEFORE,
          goFile(TEST_SUB, goTest("TestSubZero", ["Sub(0, 0) != 0"])),
        ),
      ],
      "plain",
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.report).toContain("Test functions: 1 → 2");
    expect(outcome.report).not.toContain(ALLOWED_HEADER);
    expect(outcome.report).not.toContain(ALLOWED_TOTALS);
    expect(outcome.report).not.toContain(OTHER_TOTALS);
  });
});
