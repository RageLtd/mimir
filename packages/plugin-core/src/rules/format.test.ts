import { describe, expect, test } from "bun:test";
import {
  applyMessageTemplate,
  formatFindings,
  formatLoadErrors,
  renderTemplate,
} from "./format";
import type { Finding, LoadError, RuleEntry } from "./types";

const rule = (overrides: Partial<RuleEntry> = {}): RuleEntry => ({
  id: "test/r",
  enabled: true,
  event: "file",
  conditions: [],
  sourcePath: "/tmp/r.enforce.toml",
  ...overrides,
});

describe("renderTemplate", () => {
  test("interpolates ${match} and numbered captures", () => {
    expect(
      renderTemplate("got ${1} via ${match}", ["FOO BAR", "FOO"], undefined),
    ).toBe("got FOO via FOO BAR");
  });

  test("interpolates ${line} when defined", () => {
    expect(renderTemplate("at ${line}", ["x"], 42)).toBe("at 42");
  });

  test("blank ${line} when undefined", () => {
    expect(renderTemplate("at ${line}", ["x"], undefined)).toBe("at ");
  });

  test("leaves unknown placeholders intact", () => {
    expect(renderTemplate("hi ${typo}", [], undefined)).toBe("hi ${typo}");
  });
});

describe("applyMessageTemplate", () => {
  test("uses the rule message when set", () => {
    const r = rule({ message: "found ${1}" });
    const v = applyMessageTemplate(
      r,
      { message: "literal", line: 3 },
      ["FULL", "G1"],
    );
    expect(v.message).toBe("found G1");
    expect(v.line).toBe(3);
  });

  test("returns the violation untouched when no template", () => {
    const r = rule();
    const v = applyMessageTemplate(
      r,
      { message: "literal" },
      ["FULL"],
    );
    expect(v.message).toBe("literal");
  });
});

describe("formatFindings", () => {
  test("returns null for empty findings", () => {
    expect(formatFindings([])).toBeNull();
  });

  test("renders header, rule line, violation bullets, and rule body", () => {
    const finding: Finding = {
      rule: rule({
        id: "coding/return-types",
        body: "/proj/.claude/rules/coding/return-types.md",
        bodyContent: "# No explicit return types\nLet TS infer.",
      }),
      violations: [
        { message: "annotation", line: 12, snippet: "): string =>" },
      ],
    };
    const out = formatFindings([finding]);
    expect(out).not.toBeNull();
    expect(out).toContain("⚠️");
    expect(out).toContain("Rule: coding/return-types");
    expect(out).toContain("Line 12");
    expect(out).toContain("`): string =>`");
    expect(out).toContain("--- rule content ---");
    expect(out).toContain("Let TS infer");
  });

  test("omits rule body block when bodyContent absent", () => {
    const finding: Finding = {
      rule: rule(),
      violations: [{ message: "x" }],
    };
    const out = formatFindings([finding]);
    expect(out).not.toContain("--- rule content ---");
  });
});

describe("formatLoadErrors", () => {
  test("returns null when there are no errors", () => {
    expect(formatLoadErrors([])).toBeNull();
  });

  test("renders one consolidated message with each error path + reason", () => {
    const errors: LoadError[] = [
      {
        path: "/proj/.claude/rules/a.enforce.toml",
        id: "a",
        message: "regex invalid",
      },
      {
        path: "/proj/.claude/rules/b.enforce.toml",
        message: "missing id",
      },
    ];
    const out = formatLoadErrors(errors);
    expect(out).not.toBeNull();
    expect(out).toContain("2 rules failed to load");
    expect(out).toContain("[a]");
    expect(out).toContain("regex invalid");
    expect(out).toContain("missing id");
    expect(out).toContain("/proj/.claude/rules/b.enforce.toml");
  });

  test("singular noun for one error", () => {
    const out = formatLoadErrors([
      { path: "/x.toml", message: "boom" },
    ]);
    expect(out).toContain("1 rule failed to load");
  });
});
