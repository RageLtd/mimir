/**
 * The role-boundary note reaches the gate's block message. The rule itself
 * is held in `role-boundary.test.ts`; here the gate is shown to give it the
 * failed command's whole output and the files that exist on disk. The
 * change set is handed in and toolchain commands are scripted, so no
 * command runs.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  changed,
  changeSet,
  fixedChanges,
  gateSandbox,
  toolchain,
} from "./change-fixtures.test-helpers";
import { runVerify } from "./verify";

const BUILD = "go build ./...";
const VET = "go vet ./...";
const DONE = "STATUS: done";
const BLOCKED = "STATUS: blocked";

const ADD = "package x\nfunc Add(a, b int) int { return a + b }\n";
const ADD_AND_SUB =
  "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n";
const TEST_ADD =
  'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\n';
const TEST_ADD_AND_ZERO =
  'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestAddZero(t *testing.T) { if Add(0,0) != 0 { t.Fatal("bad") } }\n';
const TEST_SUB =
  'package x\nimport "testing"\nfunc TestSub(t *testing.T) { if Sub(3,1) != 2 { t.Fatal("bad") } }\n';

/** The gate looks the named files up on disk, so they are really there. */
const ON_DISK = {
  "go.mod": "module x\n",
  "add.go": ADD,
  "add_test.go": TEST_ADD,
};

const { project } = gateSandbox();

describe("runVerify role-boundary note", () => {
  test("a test worker whose check fails only in an implementation file is told so, from beyond the output tail", async () => {
    const root = await project(ON_DISK);
    const lastLine = "vet: 1 issue found";
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "boundary-test-role",
      // A one-line tail: the file is named only above it.
      tail: 1,
      changes: fixedChanges(
        changeSet([changed("add_test.go", TEST_ADD, TEST_ADD_AND_ZERO)]),
      ),
      run: toolchain({
        [VET]: {
          code: 1,
          out: `# x\nadd.go:2:6: result of Add is never used\n${lastLine}\n`,
        },
      }),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain(lastLine);
      expect(outcome.reason).toContain("add.go");
      expect(outcome.reason).toContain(BLOCKED);
      expect(outcome.reason).toContain("mimir-impl");
    }
  });

  test("an implementation worker whose typecheck fails only in a test file is told so", async () => {
    const root = await project(ON_DISK);
    const outcome = await runVerify({
      worktree: root,
      lastMessage: DONE,
      agentId: "boundary-impl-role",
      changes: fixedChanges(
        changeSet([
          changed("add_test.go", TEST_ADD, TEST_SUB),
          changed("add.go", ADD, ADD_AND_SUB),
        ]),
      ),
      run: toolchain({
        [BUILD]: {
          code: 1,
          out: `# x\n${join(root, "add_test.go")}:3:9: too many arguments in call to Sub\n`,
        },
      }),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("too many arguments in call to Sub");
      expect(outcome.reason).toContain(BLOCKED);
      expect(outcome.reason).toContain("mimir-test");
    }
  });
});
