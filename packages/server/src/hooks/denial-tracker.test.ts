import { describe, expect, test } from "bun:test";
import { createDenialTracker, denialKey } from "./denial-tracker";

describe("DenialTracker", () => {
  test("first denial does not exceed threshold", () => {
    const tracker = createDenialTracker(3);
    const result = tracker.recordDenial("bash", { command: "rm -rf /" }, "fp1");
    expect(result.exceeded).toBe(false);
    expect(result.count).toBe(1);
  });

  test("exceeds threshold after N consecutive denials", () => {
    const tracker = createDenialTracker(3);
    const args = { command: "git push --force" };

    tracker.recordDenial("bash", args, "fp1");
    tracker.recordDenial("bash", args, "fp1");
    const result = tracker.recordDenial("bash", args, "fp1");

    expect(result.exceeded).toBe(true);
    expect(result.count).toBe(3);
  });

  test("different commands tracked independently", () => {
    const tracker = createDenialTracker(3);

    tracker.recordDenial("bash", { command: "rm -rf /" }, "fp1");
    tracker.recordDenial("bash", { command: "rm -rf /" }, "fp1");

    const result = tracker.recordDenial(
      "bash",
      { command: "git push --force" },
      "fp1",
    );
    expect(result.exceeded).toBe(false);
    expect(result.count).toBe(1);
  });

  test("different conversations tracked independently", () => {
    const tracker = createDenialTracker(2);
    const args = { command: "rm -rf /" };

    tracker.recordDenial("bash", args, "fp1");
    const result = tracker.recordDenial("bash", args, "fp2");

    expect(result.exceeded).toBe(false);
    expect(result.count).toBe(1);
  });

  test("clearForConversation resets all records for that fingerprint", () => {
    const tracker = createDenialTracker(3);
    const args = { command: "rm -rf /" };

    tracker.recordDenial("bash", args, "fp1");
    tracker.recordDenial("bash", args, "fp1");
    tracker.clearForConversation("fp1");

    const result = tracker.recordDenial("bash", args, "fp1");
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  test("clearForConversation doesn't affect other conversations", () => {
    const tracker = createDenialTracker(3);
    const args = { command: "rm -rf /" };

    tracker.recordDenial("bash", args, "fp1");
    tracker.recordDenial("bash", args, "fp2");
    tracker.clearForConversation("fp1");

    const result = tracker.recordDenial("bash", args, "fp2");
    expect(result.count).toBe(2);
  });

  test("clearSpecific resets only the matching record", () => {
    const tracker = createDenialTracker(3);
    const args1 = { command: "rm -rf /" };
    const args2 = { command: "git push --force" };

    tracker.recordDenial("bash", args1, "fp1");
    tracker.recordDenial("bash", args1, "fp1");
    tracker.recordDenial("bash", args2, "fp1");

    tracker.clearSpecific("bash", args1, "fp1");

    // args1 was cleared, starts fresh
    const r1 = tracker.recordDenial("bash", args1, "fp1");
    expect(r1.count).toBe(1);

    // args2 was not cleared
    const r2 = tracker.recordDenial("bash", args2, "fp1");
    expect(r2.count).toBe(2);
  });

  test("prune removes old records", () => {
    const tracker = createDenialTracker(3);
    const args = { command: "rm -rf /" };

    tracker.recordDenial("bash", args, "fp1");
    tracker.recordDenial("bash", args, "fp1");

    // Prune with 0ms max age — everything is "old"
    tracker.prune(0);

    const result = tracker.recordDenial("bash", args, "fp1");
    expect(result.count).toBe(1); // Reset after prune
  });

  test("denialKey normalizes whitespace", () => {
    const key1 = denialKey("bash", { command: "git  push   --force" });
    const key2 = denialKey("bash", { command: "git push --force" });
    expect(key1).toBe(key2);
  });

  test("null fingerprint uses global scope", () => {
    const tracker = createDenialTracker(2);
    const args = { command: "rm -rf /" };

    tracker.recordDenial("bash", args, null);
    const result = tracker.recordDenial("bash", args, null);

    expect(result.exceeded).toBe(true);
    expect(result.count).toBe(2);
  });
});
