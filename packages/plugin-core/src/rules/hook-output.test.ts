import { describe, expect, test } from "bun:test";
import { mergeVerdicts, preToolUseOutput } from "./hook-output";

describe("preToolUseOutput", () => {
  test("clean verdict → null (adapter stays silent)", () => {
    expect(preToolUseOutput({ block: null, nudge: null })).toBeNull();
  });

  test("nudge only → additionalContext, no permission decision", () => {
    const out = preToolUseOutput({ block: null, nudge: "advice" });
    expect(out?.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: "advice",
    });
  });

  test("block → deny with the block text as the reason", () => {
    const out = preToolUseOutput({ block: "stop", nudge: null });
    expect(out?.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "stop",
    });
  });

  test("block + nudge → deny, advice rides along", () => {
    const out = preToolUseOutput({ block: "stop", nudge: "advice" });
    expect(out?.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "stop",
      additionalContext: "advice",
    });
  });
});

describe("mergeVerdicts", () => {
  test("joins blocks and nudges across calls, null when none", () => {
    expect(
      mergeVerdicts([
        { block: null, nudge: "a" },
        { block: "b1", nudge: null },
        { block: "b2", nudge: "c" },
      ]),
    ).toEqual({ block: "b1\n\nb2", nudge: "a\n\nc" });
    expect(mergeVerdicts([{ block: null, nudge: null }])).toEqual({
      block: null,
      nudge: null,
    });
  });
});
