/**
 * Test files allowed to lose assertions: the coordinator names the test
 * files a task may weaken (`allowedRemovals`) — the tests of a feature the
 * task deletes — the gate accepts their assertion loss and no other, and
 * its pass report shows what each one lost. The change set is handed in
 * and toolchain commands are scripted, so no command runs.
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
const REMOVALS_HEADER = "Allowed assertion removals";
const ASSERTIONS_REMOVED = "assertions removed";
// Assembled so the literal marker never sits on one line of this file.
const SKIP_CALL = ["t", "Skip"].join(".");

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
const TEST_ADD_NEG = goTest("TestAddNeg", ["Add(-1, -2) != -3"]);
const TEST_SUB = goTest("TestSub", ["Sub(3, 1) != 2"]);

/**
 * Before the change: add_test.go holds TestAdd (2 assertions) and
 * TestAddZero (1), sub_test.go holds TestSub (1).
 */
const ADD_TEST_BEFORE = goFile(TEST_ADD, TEST_ADD_ZERO);
const SUB_TEST_BEFORE = goFile(TEST_SUB);

/** The zero-sum feature is deleted: TestAddZero and its assertion go. */
const ADD_ZERO_DROPPED = changed(ADD_TEST, ADD_TEST_BEFORE, goFile(TEST_ADD));

const { project } = gateSandbox();

const verify = async (
  files: readonly ChangedFile[],
  agentId: string,
  allowance: {
    readonly removals?: readonly string[];
    readonly deletions?: readonly string[];
  },
) =>
  runVerify({
    worktree: await project(GO),
    lastMessage: "STATUS: done",
    agentId,
    changes: fixedChanges(changeSet(files)),
    run: toolchain(),
    allowedRemovals: allowance.removals,
    allowedDeletions: allowance.deletions,
  });

describe("verify gate: test files allowed to lose assertions", () => {
  test("an allowed test file's assertion loss does not block", async () => {
    const outcome = await verify([ADD_ZERO_DROPPED], "removal-allowed", {
      removals: [ADD_TEST],
    });
    expect(outcome.kind).toBe("pass");
  });

  test("a test file that was not allowed still blocks, saying the count is a line heuristic and how to ask for the allowance", async () => {
    const outcome = await verify(
      [
        ADD_ZERO_DROPPED,
        changed(SUB_TEST, SUB_TEST_BEFORE, goFile(goTest("TestSub", []))),
      ],
      "removal-other",
      { removals: [ADD_TEST] },
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(
      `${SUB_TEST}: ${ASSERTIONS_REMOVED} (−1 net)`,
    );
    expect(outcome.reason).not.toContain(`${ADD_TEST}: ${ASSERTIONS_REMOVED}`);
    expect(outcome.reason).toContain("heuristic");
    expect(outcome.reason).toContain("shared helper");
    expect(outcome.reason).toContain("STATUS: question");
  });

  test("a skip added in an allowed test file still blocks", async () => {
    const outcome = await verify(
      [
        changed(
          ADD_TEST,
          ADD_TEST_BEFORE,
          goFile(
            `func TestAdd(t *testing.T) {\n\t${SKIP_CALL}("later")\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("TestAdd")\n\t}\n\tif Add(2, 2) != 4 {\n\t\tt.Fatal("TestAdd")\n\t}\n}`,
          ),
        ),
      ],
      "removal-skip",
      { removals: [ADD_TEST] },
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(
      `${ADD_TEST}: 1 skip/focus/ignore marker(s) added`,
    );
  });

  test("an allowed test file that gains more tests than it loses, with no assertion added, still blocks", async () => {
    // TestAddZero and its assertion go; two tests with no assertions arrive.
    const outcome = await verify(
      [
        changed(
          ADD_TEST,
          ADD_TEST_BEFORE,
          goFile(
            TEST_ADD,
            "func TestAddLater(t *testing.T) {\n\tAdd(1, 1)\n}",
            "func TestAddSoon(t *testing.T) {\n\tAdd(2, 1)\n}",
          ),
        ),
      ],
      "removal-empty-test",
      { removals: [ADD_TEST] },
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(
      `${ADD_TEST}: new tests with no assertions`,
    );
  });

  test("rewording a surviving test's title in an allowed test file does not block", async () => {
    // TestAddZero goes; TestAdd's opening line changes, its assertion lines stay.
    const renamed = TEST_ADD.replace(
      "func TestAdd(t",
      "func TestAddSmallNumbers(t",
    );
    expect(renamed).not.toBe(TEST_ADD);

    const outcome = await verify(
      [changed(ADD_TEST, ADD_TEST_BEFORE, goFile(renamed))],
      "removal-reworded-title",
      { removals: [ADD_TEST] },
    );
    expect(outcome.kind).toBe("pass");
  });

  test("an allowance to lose assertions does not excuse a deleted test file", async () => {
    const outcome = await verify(
      [changed(SUB_TEST, SUB_TEST_BEFORE, null)],
      "removal-not-deletion",
      { removals: [SUB_TEST] },
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
  });

  test("an allowance for test files that lost nothing changes nothing", async () => {
    const outcome = await verify(
      [
        changed(
          ADD_TEST,
          ADD_TEST_BEFORE,
          goFile(TEST_ADD, TEST_ADD_ZERO, TEST_ADD_NEG),
        ),
      ],
      "removal-nothing-lost",
      { removals: [ADD_TEST, SUB_TEST] },
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.report).toContain("Test functions: 2 → 3");
    expect(outcome.report).not.toContain(REMOVALS_HEADER);
  });

  test("the pass report lists each allowed file that lost assertions with its counts before and after", async () => {
    const outcome = await verify(
      [ADD_ZERO_DROPPED, changed(SUB_TEST, SUB_TEST_BEFORE, goFile())],
      "removal-report",
      { removals: [ADD_TEST, SUB_TEST] },
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${REMOVALS_HEADER} (2):`);
    expect(report).toContain(
      `  ${ADD_TEST}: 2 → 1 test functions, 3 → 2 assertions`,
    );
    expect(report).toContain(
      `  ${SUB_TEST}: 1 → 0 test functions, 1 → 0 assertions`,
    );
    // The existing lines stay as they are.
    expect(report).toContain("Test functions: 3 → 1");
    expect(report).toContain(`M ${ADD_TEST}`);
    expect(report).toContain(`M ${SUB_TEST}`);
  });
});
