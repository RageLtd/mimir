/**
 * What the OpenCode worker gate hands the verify gate for the session's
 * task. The gate is a recording stand-in and git is canned, so no command
 * runs; what the gate does with these inputs is held in plugin-core.
 *
 * On OpenCode every worker runs in the session's own directory and may
 * commit there, so "uncommitted" cannot stand for a worker's own change.
 * The gate is therefore never given an integration worktree: every run
 * reads the test-change rules from the task base and judges the whole task,
 * and the task's allowances cover an accepted earlier change.
 */

import { expect, test } from "bun:test";
import {
  delegateSandbox,
  HEAD,
  NEXT_HEAD,
  recordingGate,
} from "./delegate-sandbox";

const REMOVABLE = "add_test.go";
const DELETABLE = "sub_test.go";

const { delegate, handBack, moveHead, root, startDelegation } =
  delegateSandbox();

test("a worker's result is gated from the task base with the role of its agent", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  const gate = recordingGate();

  const outcome = await handBack("mimir-test", gate, "test-child");
  expect(outcome.kind).toBe("pass");
  expect(outcome.text).toContain("✅ report");
  expect(gate.asked[0]).toMatchObject({
    role: "test",
    worktree: root(),
    base: HEAD,
    agentId: "test-child",
  });
});

test("the gate is not given an integration worktree, so every run judges the whole task", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  // The coordinator commits an accepted result; HEAD moves past the base.
  moveHead(NEXT_HEAD);
  const gate = recordingGate();

  await handBack("mimir-impl", gate);
  expect(gate.asked[0]?.base).toBe(HEAD);
  expect(gate.asked[0]?.integrationWorktree).toBeUndefined();
});

test("the gate is handed the task's allowed deletions and removals", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: "allow-deletion", paths: [DELETABLE] });
  await delegate({ action: "allow-removal", paths: [REMOVABLE] });
  const gate = recordingGate();

  await handBack("mimir-test", gate);
  expect(gate.asked[0]).toMatchObject({
    allowedDeletions: [DELETABLE],
    allowedRemovals: [REMOVABLE],
  });
});

test("the next task's gate is handed no allowance from the one before", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  await delegate({ action: "allow-deletion", paths: [DELETABLE] });
  await delegate({ action: "allow-removal", paths: [REMOVABLE] });
  await delegate({ action: "task" });
  const gate = recordingGate();

  await handBack("mimir-test", gate);
  expect(gate.asked[0]?.allowedDeletions).toBeUndefined();
  expect(gate.asked[0]?.allowedRemovals).toBeUndefined();
});

test("a task marked as a refactor is gated as one, and an unmarked task is not", async () => {
  await startDelegation();
  await delegate({ action: "task", refactor: true });
  const marked = recordingGate();
  await handBack("mimir-impl", marked);
  expect(marked.asked[0]?.refactor).toBe(true);

  await delegate({ action: "task" });
  const unmarked = recordingGate();
  await handBack("mimir-impl", unmarked);
  expect(unmarked.asked[0]?.refactor).toBeFalsy();
});

test("a block reaches the coordinator with the gate's reason and the child to resume", async () => {
  await startDelegation();
  await delegate({ action: "task" });
  const gate = recordingGate({
    kind: "block",
    reason: "add_test.go: assertions removed (−1 net)",
    blocks: 1,
  });

  const outcome = await handBack("mimir-impl", gate, "impl-child");
  expect(outcome.kind).toBe("block");
  expect(outcome.text).toContain("add_test.go: assertions removed");
  expect(outcome.text).toContain("sessionID: impl-child");
});
