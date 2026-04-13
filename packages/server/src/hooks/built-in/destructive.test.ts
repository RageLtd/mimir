import { beforeEach, describe, expect, test } from "bun:test";
import { ApprovalTracker, approvalKey, setApprovalTracker } from "../approval";
import { HookRegistry } from "../registry";
import type { HookContext } from "../types";
import { registerDestructiveHook } from "./destructive";

function bashCtx(command: string): HookContext {
  return {
    toolName: "bash",
    args: { command },
    toolType: "server",
    project: "/test",
    fingerprint: "test-fp",
  };
}

function makeRegistry(): HookRegistry {
  const registry = new HookRegistry();
  registerDestructiveHook(registry);
  return registry;
}

describe("Destructive Action Guard", () => {
  // Reset approval tracker before each test to prevent leakage
  beforeEach(() => {
    setApprovalTracker(new ApprovalTracker());
  });

  // --- Should DENY ---

  test("denies git push --force", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git push --force origin main"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies git push -f", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git push -f origin main"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies git reset --hard", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git reset --hard HEAD~3"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies git branch -D", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git branch -D feature-branch"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies git branch -d", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git branch -d feature-branch"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies git checkout .", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("git checkout ."));
    expect(result.action).toBe("deny");
  });

  test("denies git clean -f", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("git clean -fd"));
    expect(result.action).toBe("deny");
  });

  test("denies git stash drop", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git stash drop stash@{0}"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies --no-verify", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git commit -m 'skip hooks' --no-verify"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies rm -rf", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("rm -rf /tmp/project"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies rm -r", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("rm -r /tmp/project"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies kill -9", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("kill -9 1234"));
    expect(result.action).toBe("deny");
  });

  test("denies pkill", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("pkill node"));
    expect(result.action).toBe("deny");
  });

  test("denies killall", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("killall node"));
    expect(result.action).toBe("deny");
  });

  test("denies DROP TABLE", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("surreal sql -e 'DROP TABLE users'"),
    );
    expect(result.action).toBe("deny");
  });

  test("denies TRUNCATE TABLE", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("psql -c 'TRUNCATE TABLE sessions'"),
    );
    expect(result.action).toBe("deny");
  });

  // --- Should ALLOW ---

  test("allows normal git push", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git push origin main"),
    );
    expect(result.action).toBe("allow");
  });

  test("allows git commit", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git commit -m 'add feature'"),
    );
    expect(result.action).toBe("allow");
  });

  test("allows git status", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("git status"));
    expect(result.action).toBe("allow");
  });

  test("allows normal rm (single file)", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("rm /tmp/old-file.txt"),
    );
    expect(result.action).toBe("allow");
  });

  test("allows cargo build", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo build --release"),
    );
    expect(result.action).toBe("allow");
  });

  test("allows non-bash tools", async () => {
    const result = await makeRegistry().runPreHooks({
      toolName: "memory_search",
      args: { query: "git push --force" },
      toolType: "server",
      project: "/test",
      fingerprint: "test-fp",
    });
    expect(result.action).toBe("allow");
  });

  test("allows when command arg is missing", async () => {
    const result = await makeRegistry().runPreHooks({
      toolName: "bash",
      args: {},
      toolType: "server",
      project: "/test",
      fingerprint: "test-fp",
    });
    expect(result.action).toBe("allow");
  });

  // --- Escalation ---

  test("escalates after 3 consecutive denials for same command", async () => {
    const registry = makeRegistry();
    const ctx = bashCtx("git push --force origin main");

    const r1 = await registry.runPreHooks(ctx);
    expect(r1.action).toBe("deny");
    expect((r1 as { reason: string }).reason).not.toContain("3 times");

    await registry.runPreHooks(ctx);

    const r3 = await registry.runPreHooks(ctx);
    expect(r3.action).toBe("deny");
    expect((r3 as { reason: string }).reason).toContain("3 times");
    expect((r3 as { reason: string }).reason).toContain("BLOCKED");
  });

  // --- Approval flow ---

  test("allows destructive action after approval", async () => {
    const tracker = new ApprovalTracker();
    setApprovalTracker(tracker);

    const registry = makeRegistry();
    const ctx = bashCtx("git push --force origin main");

    // First attempt: denied
    const r1 = await registry.runPreHooks(ctx);
    expect(r1.action).toBe("deny");

    // Developer approves (globally, as approve_action tool does)
    const key = approvalKey("bash", {
      command: "git push --force origin main",
    });
    tracker.approve(key, null);

    // Second attempt: allowed
    const r2 = await registry.runPreHooks(ctx);
    expect(r2.action).toBe("allow");
  });

  test("denial message mentions approve_action", async () => {
    setApprovalTracker(new ApprovalTracker());
    const result = await makeRegistry().runPreHooks(
      bashCtx("rm -rf /tmp/test"),
    );
    expect(result.action).toBe("deny");
    expect((result as { reason: string }).reason).toContain("approve_action");
  });
});
