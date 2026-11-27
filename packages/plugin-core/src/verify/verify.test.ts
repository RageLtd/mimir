/**
 * How the gate orchestrates a hand-back: what it skips, what it blocks on
 * and in which order, which commands it runs, and how the loop guard
 * counts. The change set is handed in and toolchain commands are scripted,
 * so no command runs.
 */

import { describe, expect, test } from "bun:test";
import {
  changed,
  changeSet,
  fixedChanges,
  gateSandbox,
  TASK_BASE,
  toolchain,
} from "./change-fixtures.test-helpers";
import type { ChangeSource } from "./changes";
import { runVerify } from "./verify";

const GO = { "go.mod": "module x\n" };
const DONE = "STATUS: done";

const ADD = "package x\nfunc Add(a, b int) int { return a + b }\n";
const ADD_AND_SUB =
  "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n";
const TEST_ADD =
  'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\n';
const TEST_ADD_AND_SUB =
  'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestSub(t *testing.T) { if Sub(3,1) != 2 { t.Fatal("bad") } }\n';
const TEST_SUB =
  'package x\nimport "testing"\nfunc TestSub(t *testing.T) { if Sub(3,1) != 2 { t.Fatal("bad") } }\n';

/** Source and a test changed together: nothing for the diff rules to object to. */
const SOURCE_WITH_TEST = changeSet([
  changed("add.go", ADD, ADD_AND_SUB),
  changed("add_test.go", TEST_ADD, TEST_ADD_AND_SUB),
]);
const SOURCE_ONLY = changeSet([changed("add.go", ADD, ADD_AND_SUB)]);

const { project } = gateSandbox();

describe("runVerify", () => {
  test("the gate asks the change source for the tree against the task base it was given", async () => {
    const root = await project(GO);
    const asked: (readonly [string, string | undefined])[] = [];
    const changes: ChangeSource = {
      collect: async (worktree, base) => {
        asked.push([worktree, base]);
        return SOURCE_WITH_TEST;
      },
      ownBase: async () => TASK_BASE,
    };

    const outcome = await runVerify({
      worktree: root,
      base: TASK_BASE,
      lastMessage: DONE,
      agentId: "task-base",
      changes,
      run: toolchain(),
    });
    expect(outcome.kind).toBe("pass");
    expect(asked).toEqual([[root, TASK_BASE]]);
  });

  test("a change source that fails blocks with its reason before any toolchain command", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const changes: ChangeSource = {
      collect: async () => {
        throw new Error("diff unavailable");
      },
      ownBase: async () => TASK_BASE,
    };

    const outcome = await runVerify({
      worktree: root,
      base: TASK_BASE,
      lastMessage: DONE,
      agentId: "collect-fails",
      changes,
      run: toolchain({}, seen),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("Change collection failed");
      expect(outcome.reason).toContain("diff unavailable");
    }
    expect(seen).toEqual([]);
  });

  test("a directory with no change set to read blocks as not a git worktree", async () => {
    const root = await project(GO);
    const changes: ChangeSource = {
      collect: async () => null,
      ownBase: async () => TASK_BASE,
    };

    const outcome = await runVerify({
      worktree: root,
      lastMessage: DONE,
      agentId: "no-worktree",
      changes,
      run: toolchain(),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("is not a git worktree");
  });

  test("STATUS other than done → skip, nothing runs", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "STATUS: question\nwhich?",
      agentId: "a",
      changes: fixedChanges(SOURCE_WITH_TEST),
      run: toolchain({}, seen),
    });
    expect(outcome).toEqual({ kind: "skip", status: "question" });
    expect(seen).toEqual([]);
  });

  test("done with no changes → block", async () => {
    const root = await project(GO);
    const outcome = await runVerify({
      worktree: root,
      lastMessage: DONE,
      agentId: "a",
      changes: fixedChanges(changeSet([])),
      run: toolchain(),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("No changes");
  });

  test("source change without a test → coverage block; commands never run", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: DONE,
      agentId: "a",
      changes: fixedChanges(SOURCE_ONLY),
      run: toolchain({}, seen),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("No test coverage");
    expect(seen).toEqual([]);
  });

  test("a test the branch committed before the base covers a source-only change", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: DONE,
      agentId: "a",
      changes: fixedChanges(
        changeSet([changed("add.go", ADD, ADD_AND_SUB)], {
          branchPaths: ["add_test.go"],
        }),
      ),
      run: toolchain({}, seen),
    });
    expect(outcome.kind).toBe("pass");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("clean change with a test → commands run in order → pass with report", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "done!\nSTATUS: done",
      agentId: "a",
      changes: fixedChanges(SOURCE_WITH_TEST),
      run: toolchain({}, seen),
    });
    expect(seen).toEqual(["go build ./...", "go test ./...", "go vet ./..."]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass") {
      expect(outcome.report).toContain("Verify gate passed");
      expect(outcome.report).toContain("M add.go");
      expect(outcome.report).toContain("Test functions: 1 → 2");
      expect(outcome.report).toContain("✓ test: go test ./...");
    }
  });

  test("failing command → block with the output tail; loop guard counts to exhaustion", async () => {
    const root = await project(GO);
    const opts = {
      worktree: root,
      lastMessage: DONE,
      agentId: "loop",
      changes: fixedChanges(SOURCE_WITH_TEST),
      run: toolchain({
        "go test ./...": { code: 1, out: "--- FAIL: TestSub\nFAIL\n" },
      }),
    };

    const first = await runVerify(opts);
    expect(first.kind).toBe("block");
    if (first.kind === "block") {
      expect(first.blocks).toBe(1);
      expect(first.reason).toContain("block 1/3");
      expect(first.reason).toContain("--- FAIL: TestSub");
    }
    const second = await runVerify(opts);
    expect(second.kind).toBe("block");
    const third = await runVerify(opts);
    expect(third.kind).toBe("exhausted");
    if (third.kind === "exhausted") {
      expect(third.blocks).toBe(3);
      expect(third.reason).toContain("STATUS: failed");
    }
  });

  test("no toolchain for a root → block naming it", async () => {
    const root = await project({ "main.zig": "pub fn main() void {}\n" });
    const outcome = await runVerify({
      worktree: root,
      lastMessage: DONE,
      agentId: "z",
      changes: fixedChanges(
        changeSet([
          changed("lib.py", null, "def f():\n    return 1\n"),
          changed("test_lib.py", null, "def test_f():\n    assert f() == 1\n"),
        ]),
      ),
      run: toolchain(),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("No verification toolchain");
      expect(outcome.reason).toContain("mimir.toml");
    }
  });

  test("role test: red tests are expected, so the test command is skipped", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "t",
      changes: fixedChanges(
        changeSet([changed("sub_test.go", null, TEST_SUB)]),
      ),
      run: toolchain({ "go test ./...": { code: 1 } }, seen),
    });
    // Red-first tests may not even compile yet (a new export under test), so
    // typecheck is skipped for the test role along with the test command.
    expect(seen).toEqual(["go vet ./..."]);
    expect(outcome.kind).toBe("pass");
  });

  test("role test: sanity still applies (a skipped test is wrong)", async () => {
    const root = await project(GO);
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "t2",
      changes: fixedChanges(
        changeSet([
          changed(
            "skip_test.go",
            null,
            'package x\nimport "testing"\nfunc TestSkip(t *testing.T) { t.Skip("later") }\n',
          ),
        ]),
      ),
      run: toolchain(),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") expect(outcome.reason).toContain("skip");
  });

  test("no verification command ran → block (a pass that checked nothing is worthless)", async () => {
    // Explicit config with only `test`: the test role skips it, leaving nothing.
    const root = await project({
      ...GO,
      "mimir.toml": '[verify]\ntest = "run-tests"\n',
    });
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "none",
      changes: fixedChanges(
        changeSet([changed("add_test.go", TEST_ADD, TEST_ADD_AND_SUB)]),
      ),
      run: toolchain({}, seen),
    });
    expect(seen).toEqual([]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("No verification command ran");
  });

  test("allowEmpty: a clean tree runs the project root's toolchain and passes", async () => {
    const root = await project(GO);
    const seen: string[] = [];
    const outcome = await runVerify({
      allowEmpty: true,
      worktree: root,
      lastMessage: DONE,
      agentId: "integration",
      changes: fixedChanges(changeSet([])),
      run: toolchain({}, seen),
    });
    expect(seen).toEqual(["go build ./...", "go test ./...", "go vet ./..."]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass")
      expect(outcome.report).toContain("Changed files (0)");
  });

  test("role review: the gate does not apply", async () => {
    const root = await project(GO);
    const outcome = await runVerify({
      role: "review",
      worktree: root,
      lastMessage: "Findings: none.\nSTATUS: done",
      agentId: "r",
      changes: fixedChanges(SOURCE_WITH_TEST),
      run: toolchain(),
    });
    expect(outcome).toEqual({ kind: "skip", status: "done" });
  });

  test("a pass clears the loop guard", async () => {
    const root = await project(GO);
    const base = {
      worktree: root,
      lastMessage: DONE,
      agentId: "clear",
      changes: fixedChanges(SOURCE_WITH_TEST),
    };
    const failing = toolchain({ "go test ./...": { code: 1 } });
    const passing = toolchain();
    expect((await runVerify({ ...base, run: failing })).kind).toBe("block");
    expect((await runVerify({ ...base, run: passing })).kind).toBe("pass");
    const again = await runVerify({ ...base, run: failing });
    expect(again.kind).toBe("block");
    if (again.kind === "block") expect(again.blocks).toBe(1);
  });
});
