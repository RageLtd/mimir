/**
 * Rule-hooks unit tests.
 *
 * Covers:
 *   - extractEditTarget: pulls filePath + content from tool input variants
 *   - runDetectors: collects violations, swallows detector throws
 *   - formatFindings: produces null when empty, readable nudge otherwise
 *   - buildRuleHook: returns PreToolUse matcher with additionalContext
 *     only when findings exist
 *
 * Loader/import paths are covered by an integration test elsewhere; unit
 * tests stay in-process and don't touch the filesystem.
 */

import { describe, expect, test } from "bun:test";
import {
  buildRuleHook,
  type Detector,
  extractEditTarget,
  formatFindings,
  runDetectors,
  type Violation,
} from "./rule-hooks";

const mkDetector = (
  name: string,
  fn: (input: { content?: string; filePath?: string }) => Violation[] | null,
  ruleContent: string | null = null,
): Detector => ({
  name,
  rulePath: `.claude/rules/${name}.md`,
  ruleContent,
  detect: fn,
});

describe("extractEditTarget", () => {
  test("Edit pulls file_path + new_string", () => {
    expect(
      extractEditTarget("Edit", {
        file_path: "/tmp/foo.ts",
        old_string: "a",
        new_string: "b",
      }),
    ).toEqual({ filePath: "/tmp/foo.ts", content: "b" });
  });

  test("Write pulls file_path + content", () => {
    expect(
      extractEditTarget("Write", {
        file_path: "/tmp/foo.ts",
        content: "hello world",
      }),
    ).toEqual({ filePath: "/tmp/foo.ts", content: "hello world" });
  });

  test("MultiEdit concatenates new_strings", () => {
    expect(
      extractEditTarget("MultiEdit", {
        file_path: "/tmp/foo.ts",
        edits: [
          { old_string: "a", new_string: "alpha" },
          { old_string: "b", new_string: "beta" },
        ],
      }),
    ).toEqual({ filePath: "/tmp/foo.ts", content: "alpha\nbeta" });
  });

  test("ignores non-edit tools", () => {
    expect(extractEditTarget("Bash", { command: "ls" })).toEqual({
      filePath: undefined,
      content: undefined,
    });
  });

  test("missing file_path returns undefined", () => {
    expect(extractEditTarget("Edit", { new_string: "foo" })).toEqual({
      filePath: undefined,
      content: "foo",
    });
  });
});

describe("runDetectors", () => {
  test("collects violations from each detector", async () => {
    const d1 = mkDetector("rule-a", (i) =>
      i.content?.includes("bad") ? [{ message: "found bad" }] : null,
    );
    const d2 = mkDetector("rule-b", (i) =>
      i.content?.includes("worse") ? [{ message: "found worse" }] : null,
    );
    const findings = await runDetectors([d1, d2], "Edit", {
      file_path: "/x.ts",
      new_string: "bad code, worse code",
    });
    expect(findings).toHaveLength(2);
    const names = findings.map((f) => f.detector.name);
    expect(names).toEqual(["rule-a", "rule-b"]);
  });

  test("omits detectors with no violations", async () => {
    const d = mkDetector("rule-a", () => []);
    const findings = await runDetectors([d], "Edit", {
      file_path: "/x.ts",
      new_string: "clean",
    });
    expect(findings).toEqual([]);
  });

  test("swallows throws from a single detector", async () => {
    const d1 = mkDetector("crashy", () => {
      throw new Error("boom");
    });
    const d2 = mkDetector("working", () => [{ message: "ok" }]);
    const findings = await runDetectors([d1, d2], "Edit", {
      file_path: "/x.ts",
      new_string: "anything",
    });
    expect(findings).toHaveLength(1);
    const names = findings.map((f) => f.detector.name);
    expect(names).toEqual(["working"]);
  });
});

describe("formatFindings", () => {
  test("returns null when empty", () => {
    expect(formatFindings([])).toBeNull();
  });

  test("formats rule name, path, line, snippet", () => {
    const detector = mkDetector("return-types", () => []);
    const out = formatFindings([
      {
        detector,
        violations: [
          {
            message: "Explicit return type annotation.",
            line: 42,
            snippet: "): Promise<Foo>",
          },
        ],
      },
    ]);
    expect(out).toContain("return-types");
    expect(out).toContain(".claude/rules/return-types.md");
    expect(out).toContain("Line 42");
    expect(out).toContain("): Promise<Foo>");
  });

  test("inlines rule markdown content when detector has it", () => {
    const detector = mkDetector(
      "return-types",
      () => [],
      "# No Explicit Return Type Annotations\n\nLet TypeScript infer.",
    );
    const out = formatFindings([
      {
        detector,
        violations: [{ message: "flagged", line: 1 }],
      },
    ]);
    expect(out).toContain("--- rule content ---");
    expect(out).toContain("# No Explicit Return Type Annotations");
    expect(out).toContain("Let TypeScript infer.");
    expect(out).toContain("--- end rule ---");
  });

  test("omits rule content block when detector has none", () => {
    const detector = mkDetector("return-types", () => [], null);
    const out = formatFindings([
      {
        detector,
        violations: [{ message: "flagged", line: 1 }],
      },
    ]);
    expect(out).not.toContain("--- rule content ---");
    expect(out).not.toContain("--- end rule ---");
    // Violation header + body still rendered without the rule block.
    expect(out).toContain("return-types");
    expect(out).toContain("flagged");
  });
});

describe("buildRuleHook", () => {
  test("returns empty additionalContext when no violations", async () => {
    const d = mkDetector("rule-a", () => []);
    const matchers = buildRuleHook([d]);
    const matcher = matchers[0];
    if (!matcher || !matcher.hooks[0]) throw new Error("no hook returned");
    const result = await matcher.hooks[0](
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/x.ts", new_string: "clean" },
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(
      (result.hookSpecificOutput as { additionalContext?: string })
        .additionalContext,
    ).toBeUndefined();
  });

  test("includes additionalContext when violations found", async () => {
    const d = mkDetector("rule-a", () => [{ message: "found bad" }]);
    const matchers = buildRuleHook([d]);
    const matcher = matchers[0];
    if (!matcher || !matcher.hooks[0]) throw new Error("no hook returned");
    const result = await matcher.hooks[0](
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/x.ts", new_string: "bad" },
      },
      undefined,
      { signal: new AbortController().signal },
    );
    const ctx = (
      result.hookSpecificOutput as { additionalContext?: string }
    ).additionalContext;
    expect(ctx).toContain("rule-a");
    expect(ctx).toContain("found bad");
  });

  test("no-ops on non-PreToolUse events", async () => {
    const d = mkDetector("rule-a", () => [{ message: "shouldn't fire" }]);
    const matchers = buildRuleHook([d]);
    const matcher = matchers[0];
    if (!matcher || !matcher.hooks[0]) throw new Error("no hook returned");
    const result = await matcher.hooks[0](
      { hook_event_name: "PostToolUse" },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(
      (result.hookSpecificOutput as { additionalContext?: string })
        .additionalContext,
    ).toBeUndefined();
  });
});
