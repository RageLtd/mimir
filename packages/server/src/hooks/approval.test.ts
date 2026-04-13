import { beforeEach, describe, expect, test } from "bun:test";
import { ApprovalTracker, approvalKey } from "./approval";

describe("approvalKey", () => {
  test("generates key from bash command", () => {
    const key = approvalKey("bash", {
      command: "git push --force origin main",
    });
    expect(key).toBe("bash:git push --force origin main");
  });

  test("normalizes whitespace in bash commands", () => {
    const key = approvalKey("bash", { command: "git  push   --force" });
    expect(key).toBe("bash:git push --force");
  });

  test("uses cmd fallback", () => {
    const key = approvalKey("bash", { cmd: "rm -rf /tmp/test" });
    expect(key).toBe("bash:rm -rf /tmp/test");
  });

  test("generates key from sorted arg keys for non-bash tools", () => {
    const key = approvalKey("delete_file", { path: "/foo", force: true });
    expect(key).toBe("delete_file:force,path");
  });

  test("handles empty args", () => {
    const key = approvalKey("bash", {});
    expect(key).toBe("bash:");
  });
});

describe("ApprovalTracker", () => {
  let tracker: ApprovalTracker;

  beforeEach(() => {
    tracker = new ApprovalTracker();
  });

  test("approve and isApproved round-trips", () => {
    tracker.approve("bash:git push --force", "fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(true);
  });

  test("isApproved returns false for unapproved keys", () => {
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(false);
  });

  test("approvals are scoped to fingerprint", () => {
    tracker.approve("bash:git push --force", "fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-2")).toBe(false);
  });

  test("multiple approvals for same fingerprint", () => {
    tracker.approve("bash:git push --force", "fp-1");
    tracker.approve("bash:rm -rf /tmp", "fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(true);
    expect(tracker.isApproved("bash:rm -rf /tmp", "fp-1")).toBe(true);
  });

  test("clear removes all approvals for a fingerprint", () => {
    tracker.approve("bash:git push --force", "fp-1");
    tracker.approve("bash:rm -rf /tmp", "fp-1");
    tracker.clear("fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(false);
    expect(tracker.count("fp-1")).toBe(0);
  });

  test("clear does not affect other fingerprints", () => {
    tracker.approve("bash:git push --force", "fp-1");
    tracker.approve("bash:git push --force", "fp-2");
    tracker.clear("fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-2")).toBe(true);
  });

  test("revoke removes a specific approval", () => {
    tracker.approve("bash:git push --force", "fp-1");
    tracker.approve("bash:rm -rf /tmp", "fp-1");
    tracker.revoke("bash:git push --force", "fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(false);
    expect(tracker.isApproved("bash:rm -rf /tmp", "fp-1")).toBe(true);
  });

  test("count tracks approvals per fingerprint", () => {
    expect(tracker.count("fp-1")).toBe(0);
    tracker.approve("bash:git push --force", "fp-1");
    tracker.approve("bash:rm -rf /tmp", "fp-1");
    expect(tracker.count("fp-1")).toBe(2);
  });

  test("size tracks total across all fingerprints", () => {
    expect(tracker.size).toBe(0);
    tracker.approve("bash:git push --force", "fp-1");
    tracker.approve("bash:rm -rf /tmp", "fp-2");
    expect(tracker.size).toBe(2);
  });

  test("null fingerprint maps to global", () => {
    tracker.approve("bash:git push --force", null);
    expect(tracker.isApproved("bash:git push --force", null)).toBe(true);
  });

  test("global approval is visible from any fingerprint", () => {
    tracker.approve("bash:git push --force", null);
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(true);
    expect(tracker.isApproved("bash:git push --force", "fp-2")).toBe(true);
  });

  test("scoped approval takes precedence over global check", () => {
    tracker.approve("bash:git push --force", "fp-1");
    expect(tracker.isApproved("bash:git push --force", "fp-1")).toBe(true);
    // Not globally approved, so fp-2 shouldn't see it
    expect(tracker.isApproved("bash:git push --force", "fp-2")).toBe(false);
  });

  test("revoke cleans up empty sets", () => {
    tracker.approve("bash:git push --force", "fp-1");
    tracker.revoke("bash:git push --force", "fp-1");
    expect(tracker.count("fp-1")).toBe(0);
    expect(tracker.size).toBe(0);
  });
});
