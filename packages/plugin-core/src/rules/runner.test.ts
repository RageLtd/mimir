import { describe, expect, test } from "bun:test";
import {
  compileCondition,
  eventMatchesTool,
  runAndFormat,
  runRules,
} from "./runner";
import type { CompiledCondition, DetectorContext, RuleEntry } from "./types";

const ctx = (
  toolName: string,
  toolInput: Record<string, unknown>,
): DetectorContext => ({
  toolName,
  toolInput,
  projectPath: "/tmp/proj",
});

const rule = (overrides: Partial<RuleEntry> = {}): RuleEntry => ({
  id: "test/r",
  enabled: true,
  event: "file",
  conditions: [],
  sourcePath: "/tmp/r.enforce.toml",
  ...overrides,
});

const compileFor = async (
  fields: Array<{ field: string; pattern: string }>,
): Promise<CompiledCondition[]> => {
  const out: CompiledCondition[] = [];
  for (const f of fields) {
    const c = await compileCondition({
      field: f.field,
      operator: "regex_match",
      pattern: f.pattern,
    });
    if (!c.ok) throw new Error(c.error);
    out.push(c.condition);
  }
  return out;
};

describe("eventMatchesTool", () => {
  test("file maps to CC + server tool names", () => {
    expect(eventMatchesTool("file", "Edit")).toBe(true);
    expect(eventMatchesTool("file", "Write")).toBe(true);
    expect(eventMatchesTool("file", "MultiEdit")).toBe(true);
    expect(eventMatchesTool("file", "fs_write_text_file")).toBe(true);
    expect(eventMatchesTool("file", "write_text_file")).toBe(true);
  });

  test("bash maps to CC + server terminal tools", () => {
    expect(eventMatchesTool("bash", "Bash")).toBe(true);
    expect(eventMatchesTool("bash", "create_terminal")).toBe(true);
    expect(eventMatchesTool("bash", "terminal")).toBe(true);
  });

  test("all matches everything", () => {
    expect(eventMatchesTool("all", "AnyTool")).toBe(true);
  });

  test("unknown event returns false", () => {
    expect(eventMatchesTool("file", "Bash")).toBe(false);
    expect(eventMatchesTool("nope", "Edit")).toBe(false);
  });
});

describe("runRules — basic flow", () => {
  test("rule fires when condition matches and tool is in scope", async () => {
    const conditions = await compileFor([
      { field: "new_text", pattern: "BAD" },
    ]);
    const r = rule({ id: "no-bad", conditions });
    const findings = await runRules([r], ctx("Edit", { new_string: "BAD" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule.id).toBe("no-bad");
  });

  test("disabled rule never fires", async () => {
    const conditions = await compileFor([
      { field: "new_text", pattern: "BAD" },
    ]);
    const r = rule({ enabled: false, conditions });
    const findings = await runRules([r], ctx("Edit", { new_string: "BAD" }));
    expect(findings).toHaveLength(0);
  });

  test("rule does not fire when event doesn't match the tool", async () => {
    const conditions = await compileFor([{ field: "command", pattern: "rm" }]);
    const r = rule({ event: "bash", conditions });
    const findings = await runRules([r], ctx("Edit", { new_string: "rm" }));
    expect(findings).toHaveLength(0);
  });
});

describe("runRules — multi-condition AND", () => {
  test("all conditions must match", async () => {
    const conditions = await compileFor([
      { field: "file_path", pattern: "package\\.json$" },
      { field: "new_text", pattern: '"dependencies"' },
    ]);
    const r = rule({ id: "deps-pkg", conditions });
    const matchCtx = ctx("Edit", {
      file_path: "/proj/package.json",
      new_string: '"dependencies": {}',
    });
    expect(await runRules([r], matchCtx)).toHaveLength(1);

    const wrongPath = ctx("Edit", {
      file_path: "/proj/Cargo.toml",
      new_string: '"dependencies": {}',
    });
    expect(await runRules([r], wrongPath)).toHaveLength(0);
  });
});

describe("runRules — negative_conditions (AND-NOT)", () => {
  test("matched negative suppresses the rule", async () => {
    const conditions = await compileFor([
      { field: "command", pattern: "\\| grep" },
    ]);
    const negatives = await compileFor([{ field: "command", pattern: "2>" }]);
    const r = rule({
      event: "bash",
      conditions,
      negativeConditions: negatives,
    });
    const suppressed = ctx("Bash", {
      command: "cmd 2>err.log | grep foo",
    });
    expect(await runRules([r], suppressed)).toHaveLength(0);

    const fires = ctx("Bash", { command: "cmd | grep foo" });
    expect(await runRules([r], fires)).toHaveLength(1);
  });
});

describe("runRules — exclude_globs", () => {
  test("path matching exclude_globs drops the rule for this call", async () => {
    const conditions = await compileFor([
      { field: "new_text", pattern: "console\\.log" },
    ]);
    const r = rule({
      conditions,
      excludeGlobs: ["**/*.test.ts", "**/*.spec.ts"],
    });
    const excluded = ctx("Edit", {
      file_path: "/proj/src/foo.test.ts",
      new_string: "console.log('hi')",
    });
    expect(await runRules([r], excluded)).toHaveLength(0);

    const fires = ctx("Edit", {
      file_path: "/proj/src/foo.ts",
      new_string: "console.log('hi')",
    });
    expect(await runRules([r], fires)).toHaveLength(1);
  });
});

describe("runRules — message templates", () => {
  test("rule message gets capture-group interpolation", async () => {
    const conditions = await compileFor([
      { field: "command", pattern: "\\| (head|tail)" },
    ]);
    const r = rule({
      event: "bash",
      conditions,
      message: ["pipes into $", "{1}"].join(""),
    });
    const findings = await runRules([r], ctx("Bash", { command: "ls | head" }));
    expect(findings[0]?.violations[0]?.message).toBe("pipes into head");
  });
});

describe("runRules — builtin detector", () => {
  test("dispatches to builtin and returns its violations", async () => {
    const r = rule({
      id: "file-length",
      detector: "builtin:file-length",
      detectorArgs: { limit: 5 },
      conditions: undefined,
    });
    // file-length reads from disk; for a Write tool it can use input.content
    // directly without disk access.
    const findings = await runRules(
      [r],
      ctx("Write", {
        file_path: "/tmp/never-read.ts",
        content: "1\n2\n3\n4\n5\n6\n7\n8",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.violations[0]?.message).toContain("8 lines");
  });

  test("unknown builtin → no findings (loader catches it; runner stays defensive)", async () => {
    const r = rule({
      detector: "builtin:does-not-exist",
      conditions: undefined,
    });
    const findings = await runRules([r], ctx("Edit", { new_string: "x" }));
    expect(findings).toHaveLength(0);
  });
});

describe("runAndFormat", () => {
  test("returns null when no findings", async () => {
    const out = await runAndFormat([], ctx("Edit", { new_string: "x" }));
    expect(out).toBeNull();
  });

  test("returns a formatted string when findings present", async () => {
    const conditions = await compileFor([
      { field: "new_text", pattern: "BAD" },
    ]);
    const r = rule({ id: "no-bad", conditions });
    const out = await runAndFormat([r], ctx("Edit", { new_string: "BAD" }));
    expect(out).not.toBeNull();
    expect(out).toContain("Rule: no-bad");
  });
});

describe("compileCondition", () => {
  test("compiles a valid regex pattern", async () => {
    const r = await compileCondition({
      field: "new_text",
      operator: "regex_match",
      pattern: "ab+c",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.condition.regex).toBeInstanceOf(RegExp);
  });

  test("returns ok=false for invalid regex", async () => {
    const r = await compileCondition({
      field: "new_text",
      operator: "regex_match",
      pattern: "a(b",
    });
    expect(r.ok).toBe(false);
  });

  test("non-regex operators pass through unchanged", async () => {
    const r = await compileCondition({
      field: "new_text",
      operator: "contains",
      pattern: "FOO",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.condition.regex).toBeUndefined();
  });
});
