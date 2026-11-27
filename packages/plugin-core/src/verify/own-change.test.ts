/**
 * Given the integration worktree, the gate judges a worker on its own
 * change: the sanity rules read the worker's tree against the commit its
 * branch shares with the integration worktree's HEAD, while coverage and
 * the pass report still read from the task base. Both change sets are
 * handed in and toolchain commands are scripted, so no command runs.
 */

import { describe, expect, test } from "bun:test";
import {
  changed,
  changeSet,
  gateSandbox,
  OWN_BASE,
  TASK_BASE,
  taskAndOwnChanges,
  toolchain,
} from "./change-fixtures.test-helpers";
import type { ChangedFile, ChangeSource } from "./changes";
import { runVerify } from "./verify";

const GO = { "go.mod": "module x\n" };
const INTEGRATION = "/work/integration";
const SOURCE = "math.go";
const ADD_TEST = "add_test.go";
const SUB_TEST = "sub_test.go";
const NOTES = "NOTES.md";
const ASSERTIONS_REMOVED = "assertions removed";
const TEST_FILE_DELETED = "test file deleted";
const SKIP_ADDED = "skip/focus/ignore marker(s) added";
const NO_COVERAGE = "No test coverage";
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
const TEST_ADD_WEAKER = goTest("TestAdd", ["Add(1, 2) != 3"]);
const TEST_ADD_ZERO = goTest("TestAddZero", ["Add(0, 0) != 0"]);
const TEST_ADD_NEG = goTest("TestAddNeg", ["Add(-1, -2) != -3"]);
const TEST_SUB = goTest("TestSub", ["Sub(3, 1) != 2"]);

/**
 * At the task base: add_test.go holds TestAdd (2 assertions) and
 * TestAddZero (1), sub_test.go holds TestSub (1).
 */
const ADD_TEST_AT_BASE = goFile(TEST_ADD, TEST_ADD_ZERO);
const SUB_TEST_AT_BASE = goFile(TEST_SUB);
/** A red test collected onto the integration branch: TestAddNeg added. */
const ADD_TEST_WITH_NEG = goFile(TEST_ADD, TEST_ADD_ZERO, TEST_ADD_NEG);

/** The worker's own source change, the same in both change sets. */
const SOURCE_CHANGE = changed(
  SOURCE,
  "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n",
  "package x\nfunc Add(a, b int) int { return b + a }\nfunc Sub(a, b int) int { return a - b }\n",
);

const { project } = gateSandbox();

/**
 * A worker's hand-back. `sinceTaskBase` is its tree against the task base;
 * `own` is its tree against the commit it shares with the integration
 * worktree, that is, without what the integration branch already holds.
 */
const verify = async (
  agentId: string,
  sinceTaskBase: readonly ChangedFile[],
  own: readonly ChangedFile[],
) =>
  runVerify({
    worktree: await project(GO),
    base: TASK_BASE,
    integrationWorktree: INTEGRATION,
    lastMessage: "STATUS: done",
    agentId,
    changes: taskAndOwnChanges(
      changeSet(sinceTaskBase),
      changeSet(own, { base: OWN_BASE }),
    ),
    run: toolchain(),
  });

describe("verify gate: a worker is judged on its own change", () => {
  test("the gate reads the worker's own change from the commit it shares with the integration worktree", async () => {
    const root = await project(GO);
    const collected: (readonly [string, string | undefined])[] = [];
    const shared: (readonly [string, string])[] = [];
    const changes: ChangeSource = {
      collect: async (worktree, base) => {
        collected.push([worktree, base]);
        return changeSet([SOURCE_CHANGE], {
          base: base ?? TASK_BASE,
          branchPaths: [ADD_TEST],
        });
      },
      ownBase: async (worktree, integrationWorktree) => {
        shared.push([worktree, integrationWorktree]);
        return OWN_BASE;
      },
    };

    const outcome = await runVerify({
      worktree: root,
      base: TASK_BASE,
      integrationWorktree: INTEGRATION,
      lastMessage: "STATUS: done",
      agentId: "own-asks",
      changes,
      run: toolchain(),
    });
    expect(outcome.kind).toBe("pass");
    expect(shared).toEqual([[root, INTEGRATION]]);
    expect(collected).toEqual([
      [root, TASK_BASE],
      [root, OWN_BASE],
    ]);
  });

  test("an implementer touching no test file passes although the integration branch removed assertions after the task base", async () => {
    const outcome = await verify(
      "own-assertions",
      [
        changed(
          ADD_TEST,
          ADD_TEST_AT_BASE,
          goFile(TEST_ADD_WEAKER, TEST_ADD_ZERO),
        ),
        SOURCE_CHANGE,
      ],
      [SOURCE_CHANGE],
    );
    expect(outcome).toMatchObject({ kind: "pass" });
  });

  test("an implementer touching no test file passes although the integration branch deleted a test file after the task base", async () => {
    const outcome = await verify(
      "own-deletion",
      [
        changed(
          ADD_TEST,
          ADD_TEST_AT_BASE,
          goFile(TEST_ADD, TEST_ADD_ZERO, TEST_SUB, TEST_ADD_NEG),
        ),
        changed(SUB_TEST, SUB_TEST_AT_BASE, null),
        SOURCE_CHANGE,
      ],
      [SOURCE_CHANGE],
    );
    expect(outcome).toMatchObject({ kind: "pass" });
  });

  test("a worker that removes assertions itself is still blocked, although the task as a whole gained as many", async () => {
    // The integration branch added TestAddNeg; the worker then weakened
    // TestAdd. Since the task base the file's assertion count is level.
    const weakened = goFile(TEST_ADD_WEAKER, TEST_ADD_ZERO, TEST_ADD_NEG);
    const outcome = await verify(
      "own-weakens",
      [changed(ADD_TEST, ADD_TEST_AT_BASE, weakened), SOURCE_CHANGE],
      [changed(ADD_TEST, ADD_TEST_WITH_NEG, weakened), SOURCE_CHANGE],
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain(`${ADD_TEST}: ${ASSERTIONS_REMOVED}`);
  });

  test("a worker that adds a skip is still blocked", async () => {
    const skipped = `func TestAddZero(t *testing.T) {\n\t${SKIP_CALL}("later")\n\tif Add(0, 0) != 0 {\n\t\tt.Fatal("TestAddZero")\n\t}\n}`;
    const withSkip = goFile(TEST_ADD, skipped, TEST_ADD_NEG);
    const outcome = await verify(
      "own-skip",
      [changed(ADD_TEST, ADD_TEST_AT_BASE, withSkip), SOURCE_CHANGE],
      [changed(ADD_TEST, ADD_TEST_WITH_NEG, withSkip), SOURCE_CHANGE],
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain(`${ADD_TEST}: 1 ${SKIP_ADDED}`);
  });

  test("a worker that deletes a test file is still blocked", async () => {
    const deleted = changed(SUB_TEST, SUB_TEST_AT_BASE, null);
    const outcome = await verify(
      "own-delete",
      [
        changed(ADD_TEST, ADD_TEST_AT_BASE, ADD_TEST_WITH_NEG),
        SOURCE_CHANGE,
        deleted,
      ],
      [SOURCE_CHANGE, deleted],
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain(`${SUB_TEST}: ${TEST_FILE_DELETED}`);
  });

  test("a source-only implementer change passes coverage on a test committed on the integration branch after the task base", async () => {
    const outcome = await verify(
      "own-coverage",
      [changed(ADD_TEST, ADD_TEST_AT_BASE, ADD_TEST_WITH_NEG), SOURCE_CHANGE],
      [SOURCE_CHANGE],
    );
    expect(outcome).toMatchObject({ kind: "pass" });
  });

  test("a source-only implementer change fails coverage when no test changed anywhere since the task base", async () => {
    const outcome = await verify(
      "own-no-coverage",
      [changed(NOTES, null, "notes\n"), SOURCE_CHANGE],
      [SOURCE_CHANGE],
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") expect(outcome.reason).toContain(NO_COVERAGE);
  });

  test("the pass report lists the changed files and test-function counts from the task base", async () => {
    const outcome = await verify(
      "own-report",
      [
        changed(
          ADD_TEST,
          ADD_TEST_AT_BASE,
          goFile(TEST_ADD, TEST_ADD_ZERO, TEST_SUB, TEST_ADD_NEG),
        ),
        changed(SUB_TEST, SUB_TEST_AT_BASE, null),
        SOURCE_CHANGE,
      ],
      [SOURCE_CHANGE],
    );
    expect(outcome).toMatchObject({ kind: "pass" });
    if (outcome.kind !== "pass") return;
    expect(outcome.report).toContain(`Base: ${TASK_BASE.slice(0, 12)}`);
    expect(outcome.report).toContain("Changed files (3):");
    expect(outcome.report).toContain(`M ${ADD_TEST}`);
    expect(outcome.report).toContain(`D ${SUB_TEST}`);
    expect(outcome.report).toContain(`M ${SOURCE}`);
    // 2 in add_test.go + 1 in sub_test.go → 4 in add_test.go.
    expect(outcome.report).toContain("Test functions: 3 → 4");
  });
});
