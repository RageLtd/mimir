/**
 * A task gated as a refactor: the change keeps behaviour, so the existing
 * suite is its contract. The coverage rule does not apply, a changed test
 * blocks, in a test file or inline in a source file, and the toolchain
 * still runs. The change set is handed in and toolchain commands are
 * scripted, so no command runs.
 */

import { describe, expect, test } from "bun:test";
import {
  changed,
  changeSet,
  fixedChanges,
  gateSandbox,
  OWN_BASE,
  TASK_BASE,
  taskAndOwnChanges,
  toolchain,
} from "./change-fixtures.test-helpers";
import type { ChangeSource } from "./changes";
import type { CommandRunner } from "./exec";
import { runVerify } from "./verify";

const GO = { "go.mod": "module x\n" };
const CRATE = { "Cargo.toml": '[package]\nname = "x"\n' };
const PYTHON = { "pyproject.toml": '[project]\nname = "x"\n' };

const SOURCE = "math.go";
const ADD_TEST = "add_test.go";
const LIB_RS = "src/lib.rs";
const CONFIG_PY = "app/config.py";
const GO_TEST = "go test ./...";
const REFACTOR_MAY_NOT_CHANGE_TESTS = /refactor task may not change tests/i;
const GATED_AS_REFACTOR = /gated as a refactor/i;
// Assembled so the literal marker never sits on one line of this file.
const IGNORE_ATTR = ["#[", "ignore]"].join("");

const SOURCE_REFACTORED = changed(
  SOURCE,
  "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n",
  "package x\nfunc Add(a, b int) int { return b + a }\nfunc Sub(a, b int) int { return a - b }\n",
);
const TEST_ADDED_TO = changed(
  ADD_TEST,
  'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\n',
  'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestSub(t *testing.T) { if Sub(3,1) != 2 { t.Fatal("bad") } }\n',
);

/** A Rust library whose `add` body and inline tests module are given. */
const rustLib = (addBody: string, tests: readonly string[]) =>
  [
    `pub fn add(a: i32, b: i32) -> i32 { ${addBody} }`,
    ...(tests.length === 0
      ? []
      : ["#[cfg(test)]", "mod tests {", "    use super::*;", ...tests, "}"]),
    "",
  ].join("\n");

const ADDS_TEST = [
  "    #[test]",
  "    fn adds() { assert_eq!(add(1, 2), 3); }",
];
const ADDS_IN_ORDER_TEST = [
  "    #[test]",
  "    fn adds_in_order() { assert_eq!(add(2, 1), 3); }",
];

const { project } = gateSandbox();

const verifyRefactor = async (
  manifest: Record<string, string>,
  agentId: string,
  changes: ChangeSource,
  extra: {
    readonly integrationWorktree?: string;
    readonly allowEmpty?: boolean;
    readonly run?: CommandRunner;
  } = {},
) =>
  runVerify({
    worktree: await project(manifest),
    base: TASK_BASE,
    lastMessage: "STATUS: done",
    agentId,
    refactor: true,
    changes,
    integrationWorktree: extra.integrationWorktree,
    allowEmpty: extra.allowEmpty,
    run: extra.run ?? toolchain(),
  });

describe("verify gate: a task gated as a refactor", () => {
  test("a source-only change passes when the toolchain commands pass", async () => {
    const seen: string[] = [];
    const outcome = await verifyRefactor(
      GO,
      "refactor-source",
      fixedChanges(changeSet([SOURCE_REFACTORED])),
      { run: toolchain({}, seen) },
    );
    expect(outcome.kind).toBe("pass");
    expect(seen).toContain(GO_TEST);
  });

  test("a change that includes a test file is blocked, naming the test file", async () => {
    const outcome = await verifyRefactor(
      GO,
      "refactor-test-file",
      fixedChanges(changeSet([SOURCE_REFACTORED, TEST_ADDED_TO])),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toMatch(REFACTOR_MAY_NOT_CHANGE_TESTS);
    expect(outcome.reason).toContain(ADD_TEST);
  });

  test("a test file committed earlier in the task blocks a later worker's source-only change", async () => {
    const outcome = await verifyRefactor(
      GO,
      "refactor-earlier-test",
      taskAndOwnChanges(
        changeSet([TEST_ADDED_TO, SOURCE_REFACTORED]),
        changeSet([SOURCE_REFACTORED], { base: OWN_BASE }),
      ),
      { integrationWorktree: "/work/integration" },
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toMatch(REFACTOR_MAY_NOT_CHANGE_TESTS);
    expect(outcome.reason).toContain(ADD_TEST);
  });

  test("a source file whose inline assertion is edited is blocked, naming the file", async () => {
    const outcome = await verifyRefactor(
      CRATE,
      "refactor-inline-assert",
      fixedChanges(
        changeSet([
          changed(
            LIB_RS,
            rustLib("a + b", ADDS_TEST),
            rustLib("a + b + 1", [
              "    #[test]",
              "    fn adds() { assert_eq!(add(1, 2), 4); }",
            ]),
          ),
        ]),
      ),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toMatch(REFACTOR_MAY_NOT_CHANGE_TESTS);
    expect(outcome.reason).toContain(LIB_RS);
  });

  test("a source file that gains an inline test is blocked, naming the file", async () => {
    const outcome = await verifyRefactor(
      CRATE,
      "refactor-inline-gain",
      fixedChanges(
        changeSet([
          changed(
            LIB_RS,
            rustLib("a + b", []),
            rustLib("b + a", [
              "    #[test]",
              `    ${IGNORE_ATTR}`,
              "    fn adds() { assert_eq!(add(1, 2), 3); }",
            ]),
          ),
        ]),
      ),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toMatch(REFACTOR_MAY_NOT_CHANGE_TESTS);
    expect(outcome.reason).toContain(LIB_RS);
  });

  test("a source file that loses an inline test is blocked, naming the file", async () => {
    const outcome = await verifyRefactor(
      CRATE,
      "refactor-inline-loss",
      fixedChanges(
        changeSet([
          changed(
            LIB_RS,
            rustLib("a + b", [...ADDS_TEST, ...ADDS_IN_ORDER_TEST]),
            rustLib("a + b", ADDS_TEST),
          ),
        ]),
      ),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toMatch(REFACTOR_MAY_NOT_CHANGE_TESTS);
    expect(outcome.reason).toContain(LIB_RS);
  });

  test("a source file with inline tests passes when only its production lines change", async () => {
    const outcome = await verifyRefactor(
      CRATE,
      "refactor-inline-prod",
      fixedChanges(
        changeSet([
          changed(
            LIB_RS,
            rustLib("a + b", ADDS_TEST),
            rustLib("b + a", ADDS_TEST),
          ),
        ]),
      ),
    );
    expect(outcome.kind).toBe("pass");
  });

  test("a source file without tests passes although a changed line is a production assertion", async () => {
    const outcome = await verifyRefactor(
      PYTHON,
      "refactor-prod-assert",
      fixedChanges(
        changeSet([
          changed(
            CONFIG_PY,
            [
              "def load(path):",
              '    assert path, "a path is required"',
              "    return open(path).read()",
              "",
            ].join("\n"),
            [
              "def load(path):",
              '    assert path.endswith(".toml"), "a .toml path is required"',
              "    return open(path).read()",
              "",
            ].join("\n"),
          ),
        ]),
      ),
    );
    expect(outcome.kind).toBe("pass");
  });

  test("a failing toolchain command still blocks with its output", async () => {
    const outcome = await verifyRefactor(
      GO,
      "refactor-failing",
      fixedChanges(changeSet([SOURCE_REFACTORED])),
      {
        run: toolchain({
          [GO_TEST]: { code: 1, out: "--- FAIL: TestAdd\nFAIL\n" },
        }),
      },
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("--- FAIL: TestAdd");
  });

  test("the pass report says the task was gated as a refactor", async () => {
    const outcome = await verifyRefactor(
      GO,
      "refactor-report",
      fixedChanges(changeSet([SOURCE_REFACTORED])),
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.report).toMatch(GATED_AS_REFACTOR);
    expect(outcome.report).toContain(`M ${SOURCE}`);
  });

  test("an empty change set passes when empty is allowed", async () => {
    const outcome = await verifyRefactor(
      GO,
      "refactor-empty",
      fixedChanges(changeSet([])),
      { allowEmpty: true },
    );
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.report).toContain("Changed files (0)");
  });
});
