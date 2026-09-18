import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  cwdMissing,
  handbackOutput,
  parseVerifyArgs,
  roleOf,
  stopOutput,
} from "./verify-hook";

describe("parseVerifyArgs (coordinator CLI mode)", () => {
  test("no arguments → hook mode", () => {
    expect(parseVerifyArgs([])).toBeNull();
  });

  test("--worktree alone → impl role, no agent, changes required", () => {
    expect(parseVerifyArgs(["--worktree", "/w"])).toEqual({
      worktree: "/w",
      role: "impl",
      agentId: undefined,
      allowEmpty: false,
    });
  });

  test("every flag, any order", () => {
    expect(
      parseVerifyArgs([
        "--allow-empty",
        "--role",
        "test",
        "--agent",
        "a1e4f19f3caa94a6d",
        "--worktree",
        "/w",
      ]),
    ).toEqual({
      worktree: "/w",
      role: "test",
      agentId: "a1e4f19f3caa94a6d",
      allowEmpty: true,
    });
  });

  test("flags without --worktree, or an unknown role, is a usage error", () => {
    expect(typeof parseVerifyArgs(["--role", "test"])).toBe("string");
    expect(typeof parseVerifyArgs(["--worktree", "/w", "--role", "boss"])).toBe(
      "string",
    );
  });
});

describe("cwdMissing", () => {
  test("only a named directory that no longer exists counts", () => {
    expect(cwdMissing(undefined)).toBe(false);
    expect(cwdMissing(tmpdir())).toBe(false);
    expect(cwdMissing("/nonexistent/mimir-worktree-gone")).toBe(true);
  });
});

describe("roleOf", () => {
  test("maps worker agent types to gate roles, unknown → impl", () => {
    expect(roleOf("mimir-impl")).toBe("impl");
    expect(roleOf("mimir-test")).toBe("test");
    expect(roleOf("mimir-review")).toBe("review");
    expect(roleOf("general-purpose")).toBe("impl");
    expect(roleOf(undefined)).toBe("impl");
  });
});

describe("stopOutput (SubagentStop fallback)", () => {
  test("skip → silence", () => {
    expect(stopOutput({ kind: "skip", status: "question" })).toBeNull();
  });

  test("block → SubagentStop block decision carrying the reason", () => {
    expect(stopOutput({ kind: "block", reason: "fix it", blocks: 1 })).toEqual({
      decision: "block",
      reason: "fix it",
    });
  });

  test("pass → additionalContext with the report, stop stands", () => {
    expect(stopOutput({ kind: "pass", report: "✅" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "SubagentStop",
        additionalContext: "✅",
      },
    });
  });

  test("exhausted → additionalContext with the failed instruction", () => {
    const out = stopOutput({ kind: "exhausted", reason: "give up", blocks: 3 });
    expect(out).toHaveProperty(
      "hookSpecificOutput.additionalContext",
      "give up",
    );
    expect(out).not.toHaveProperty("decision");
  });
});

describe("handbackOutput (PreToolUse on SubagentHandback)", () => {
  const message = "Added shout().\n\nSTATUS: done";

  test("skip → silence", () => {
    expect(handbackOutput({ kind: "skip", status: null }, message)).toBeNull();
  });

  test("block → deny with the reason; the worker keeps going", () => {
    expect(
      handbackOutput({ kind: "block", reason: "no tests", blocks: 1 }, message),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no tests",
      },
    });
  });

  test("pass → allow with the report appended to the hand-back message", () => {
    const out = handbackOutput({ kind: "pass", report: "✅ report" }, message);
    expect(out?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out?.hookSpecificOutput.updatedInput?.message).toBe(
      `${message}\n\n✅ report`,
    );
  });

  test("exhausted → allow, message ends in STATUS: failed for the coordinator", () => {
    const out = handbackOutput(
      { kind: "exhausted", reason: "gave up", blocks: 3 },
      message,
    );
    const rewritten = out?.hookSpecificOutput.updatedInput?.message ?? "";
    expect(rewritten.startsWith(message)).toBe(true);
    expect(rewritten).toContain("gave up");
    expect(rewritten.trimEnd().endsWith("STATUS: failed")).toBe(true);
  });
});
