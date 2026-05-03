/**
 * Rule-hooks unit tests.
 *
 * Covers:
 *   - runDetectors: tool + glob filtering, violation collection, crash isolation
 *   - formatFindings: null on empty; rule-name/path/line/snippet formatting;
 *     inlined rule markdown body
 *   - buildRuleHook: PreToolUse matcher returns additionalContext only when
 *     a detector found a violation
 *
 * Loader/import paths are covered separately — the unit tests here don't
 * touch the filesystem.
 */

import { describe, expect, test } from "bun:test";
import {
  buildRuleHook,
  type Detector,
  formatFindings,
  runDetectors,
  type RuleDetectionInput,
  type Violation,
} from "./rule-hooks";

const mkDetector = (
  name: string,
  fn: (input: RuleDetectionInput) => Violation[] | null,
  opts: {
    ruleContent?: string | null;
    globs?: readonly string[];
    tools?: readonly string[];
  } = {},
): Detector => ({
  name,
  rulePath: `.claude/rules/${name}.md`,
  ruleContent: opts.ruleContent ?? null,
  globs: opts.globs ?? [],
  tools: opts.tools ?? [],
  detect: fn,
});

const mkHookEvent = (
  tool_name: string,
  tool_input: Record<string, unknown>,
) =>
  ({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    tool_use_id: "tu_1",
    session_id: "sess_1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
  }) as const;

describe("runDetectors", () => {
  test("collects violations from each detector", async () => {
    const d1 = mkDetector("rule-a", (input) => {
      const ti = input.hookEvent.tool_input as Record<string, unknown>;
      const s = typeof ti.new_string === "string" ? ti.new_string : "";
      return s.includes("bad") ? [{ message: "found bad" }] : null;
    });
    const d2 = mkDetector("rule-b", (input) => {
      const ti = input.hookEvent.tool_input as Record<string, unknown>;
      const s = typeof ti.new_string === "string" ? ti.new_string : "";
      return s.includes("worse") ? [{ message: "found worse" }] : null;
    });
    const findings = await runDetectors(
      [d1, d2],
      mkHookEvent("Edit", {
        file_path: "/x.ts",
        new_string: "bad code, worse code",
      }),
    );
    expect(findings).toHaveLength(2);
    const names = findings.map((f) => f.detector.name);
    expect(names).toEqual(["rule-a", "rule-b"]);
  });

  test("omits detectors with no violations", async () => {
    const d = mkDetector("rule-a", () => []);
    const findings = await runDetectors(
      [d],
      mkHookEvent("Edit", { file_path: "/x.ts", new_string: "clean" }),
    );
    expect(findings).toEqual([]);
  });

  test("swallows throws from a single detector", async () => {
    const d1 = mkDetector("crashy", () => {
      throw new Error("boom");
    });
    const d2 = mkDetector("working", () => [{ message: "ok" }]);
    const findings = await runDetectors(
      [d1, d2],
      mkHookEvent("Edit", { file_path: "/x.ts", new_string: "anything" }),
    );
    expect(findings).toHaveLength(1);
    const names = findings.map((f) => f.detector.name);
    expect(names).toEqual(["working"]);
  });

  test("filters by tools — Bash-only detector skips Edit", async () => {
    const d = mkDetector("bash-only", () => [{ message: "fired" }], {
      tools: ["Bash"],
    });
    const findings = await runDetectors(
      [d],
      mkHookEvent("Edit", { file_path: "/x.ts", new_string: "anything" }),
    );
    expect(findings).toEqual([]);
  });

  test("filters by tools — Bash-only detector fires on Bash", async () => {
    const d = mkDetector("bash-only", () => [{ message: "fired" }], {
      tools: ["Bash"],
    });
    const findings = await runDetectors(
      [d],
      mkHookEvent("Bash", { command: "ls" }),
    );
    expect(findings).toHaveLength(1);
  });

  test("filters by globs — TS-only detector skips .py file", async () => {
    const d = mkDetector("ts-only", () => [{ message: "fired" }], {
      globs: ["*.ts", "*.tsx"],
    });
    const findings = await runDetectors(
      [d],
      mkHookEvent("Edit", { file_path: "/src/foo.py", new_string: "x" }),
    );
    expect(findings).toEqual([]);
  });

  test("filters by globs — TS-only detector fires on nested .ts", async () => {
    const d = mkDetector("ts-only", () => [{ message: "fired" }], {
      globs: ["*.ts"],
    });
    const findings = await runDetectors(
      [d],
      mkHookEvent("Edit", {
        file_path: "/deeply/nested/dir/foo.ts",
        new_string: "x",
      }),
    );
    expect(findings).toHaveLength(1);
  });

  test("detectors with empty globs run on any path", async () => {
    const d = mkDetector("any-path", () => [{ message: "fired" }]);
    const findings = await runDetectors(
      [d],
      mkHookEvent("Edit", {
        file_path: "/anything.whatever",
        new_string: "x",
      }),
    );
    expect(findings).toHaveLength(1);
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
    const detector = mkDetector("return-types", () => [], {
      ruleContent: "# No Explicit Return Type Annotations\n\nLet TypeScript infer.",
    });
    const out = formatFindings([
      { detector, violations: [{ message: "flagged", line: 1 }] },
    ]);
    expect(out).toContain("--- rule content ---");
    expect(out).toContain("# No Explicit Return Type Annotations");
    expect(out).toContain("Let TypeScript infer.");
    expect(out).toContain("--- end rule ---");
  });

  test("omits rule content block when detector has none", () => {
    const detector = mkDetector("return-types", () => [], {
      ruleContent: null,
    });
    const out = formatFindings([
      { detector, violations: [{ message: "flagged", line: 1 }] },
    ]);
    expect(out).not.toContain("--- rule content ---");
    expect(out).not.toContain("--- end rule ---");
    expect(out).toContain("return-types");
    expect(out).toContain("flagged");
  });
});

// Hook returns HookJSONOutput which is a union of Sync/Async; only the Sync
// variant carries hookSpecificOutput. Tests expect the sync form so we
// narrow at the assertion site.
type SyncHookOutput = {
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string };
};

describe("buildRuleHook", () => {
  test("returns empty additionalContext when no violations", async () => {
    const d = mkDetector("rule-a", () => []);
    const matchers = buildRuleHook([d]);
    const matcher = matchers[0];
    if (!matcher || !matcher.hooks[0]) throw new Error("no hook returned");
    const result = (await matcher.hooks[0](
      mkHookEvent("Edit", { file_path: "/x.ts", new_string: "clean" }),
      undefined,
      { signal: new AbortController().signal },
    )) as SyncHookOutput;
    expect(result.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(result.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  test("includes additionalContext when violations found", async () => {
    const d = mkDetector("rule-a", () => [{ message: "found bad" }]);
    const matchers = buildRuleHook([d]);
    const matcher = matchers[0];
    if (!matcher || !matcher.hooks[0]) throw new Error("no hook returned");
    const result = (await matcher.hooks[0](
      mkHookEvent("Edit", { file_path: "/x.ts", new_string: "bad" }),
      undefined,
      { signal: new AbortController().signal },
    )) as SyncHookOutput;
    const ctx = result.hookSpecificOutput?.additionalContext;
    expect(ctx).toContain("rule-a");
    expect(ctx).toContain("found bad");
  });

  test("no-ops on non-PreToolUse events", async () => {
    const d = mkDetector("rule-a", () => [{ message: "shouldn't fire" }]);
    const matchers = buildRuleHook([d]);
    const matcher = matchers[0];
    if (!matcher || !matcher.hooks[0]) throw new Error("no hook returned");
    const result = (await matcher.hooks[0](
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {},
        tool_use_id: "tu_1",
        tool_response: {},
        session_id: "sess_1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp",
      },
      undefined,
      { signal: new AbortController().signal },
    )) as SyncHookOutput;
    expect(result.hookSpecificOutput?.additionalContext).toBeUndefined();
  });
});
