import { describe, expect, test } from "bun:test";
import {
  compileRegex,
  evaluateCondition,
  resolveField,
} from "./matcher";
import type { CompiledCondition, DetectorContext } from "./types";

const ctx = (
  toolName: string,
  toolInput: Record<string, unknown>,
): DetectorContext => ({
  toolName,
  toolInput,
  projectPath: "/tmp/proj",
});

describe("resolveField", () => {
  test("file_path / path aliases", () => {
    const c = ctx("Edit", { file_path: "/a.ts" });
    expect(resolveField("file_path", c)).toBe("/a.ts");
    expect(resolveField("path", c)).toBe("/a.ts");
  });

  test("new_text falls back across Edit / Write / MultiEdit", () => {
    expect(
      resolveField("new_text", ctx("Edit", { new_string: "abc" })),
    ).toBe("abc");
    expect(
      resolveField("new_text", ctx("Write", { content: "xyz" })),
    ).toBe("xyz");
    const me = ctx("MultiEdit", {
      edits: [{ new_string: "one" }, { new_string: "two" }],
    });
    expect(resolveField("new_text", me)).toBe("one\ntwo");
  });

  test("command field for Bash", () => {
    expect(
      resolveField("command", ctx("Bash", { command: "ls -la" })),
    ).toBe("ls -la");
  });

  test("unknown field falls back to top-level toolInput key", () => {
    expect(
      resolveField("notes", ctx("Edit", { notes: "info" })),
    ).toBe("info");
  });

  test("returns undefined for missing or non-string fields", () => {
    expect(resolveField("file_path", ctx("Edit", {}))).toBeUndefined();
    expect(
      resolveField("file_path", ctx("Edit", { file_path: 42 })),
    ).toBeUndefined();
  });
});

describe("compileRegex", () => {
  test("returns the regex for valid patterns", async () => {
    const r = await compileRegex("ab+c");
    expect(r.regex).toBeInstanceOf(RegExp);
    expect(r.error).toBeNull();
  });

  test("returns the error string for invalid patterns", async () => {
    const r = await compileRegex("a(b");
    expect(r.regex).toBeNull();
    expect(typeof r.error).toBe("string");
  });
});

describe("evaluateCondition", () => {
  const cond = (
    overrides: Partial<CompiledCondition> = {},
  ) => ({
    field: "new_text",
    operator: "regex_match" as const,
    pattern: "abc",
    regex: /abc/,
    ...overrides,
  });

  test("regex_match returns captures and snippet on match", () => {
    const r = evaluateCondition(
      cond({ pattern: "(\\d+)", regex: /(\d+)/ }),
      ctx("Edit", { new_string: "v123 y" }),
    );
    expect(r).not.toBeNull();
    expect(r?.captures[0]).toBe("123");
    expect(r?.captures[1]).toBe("123");
    expect(r?.violation.snippet).toBe("123");
    expect(r?.violation.line).toBe(1);
  });

  test("regex_match returns null on no match", () => {
    const r = evaluateCondition(
      cond(),
      ctx("Edit", { new_string: "no match here" }),
    );
    expect(r).toBeNull();
  });

  test("contains operator", () => {
    const r = evaluateCondition(
      cond({ operator: "contains", pattern: "FOO", regex: undefined }),
      ctx("Edit", { new_string: "AAA FOO BBB" }),
    );
    expect(r).not.toBeNull();
    expect(r?.violation.snippet).toBe("FOO");
  });

  test("equals operator", () => {
    const r = evaluateCondition(
      cond({
        field: "command",
        operator: "equals",
        pattern: "ls",
        regex: undefined,
      }),
      ctx("Bash", { command: "ls" }),
    );
    expect(r).not.toBeNull();
    expect(r?.captures[0]).toBe("ls");
  });

  test("equals returns null on mismatch", () => {
    const r = evaluateCondition(
      cond({
        field: "command",
        operator: "equals",
        pattern: "ls",
        regex: undefined,
      }),
      ctx("Bash", { command: "ls -la" }),
    );
    expect(r).toBeNull();
  });

  test("regex_match returns null when regex is missing (loader bug guard)", () => {
    const r = evaluateCondition(
      cond({ pattern: "abc", regex: undefined }),
      ctx("Edit", { new_string: "abc" }),
    );
    expect(r).toBeNull();
  });

  test("returns null when the field can't be resolved", () => {
    const r = evaluateCondition(
      cond({ field: "command" }),
      ctx("Edit", { new_string: "abc" }),
    );
    expect(r).toBeNull();
  });
});
