import { describe, expect, test } from "bun:test";
import { appendScopedRules, createScopedRulesSeen } from "./scoped-rules";

const entries = [
  { path: "AGENTS.md", content: "Always." },
  { path: ".claude/rules/c.md", content: "Braces.", paths: ["src/**/*.c"] },
];

describe("appendScopedRules", () => {
  test("appends matching scoped rules once per session", () => {
    const seen = createScopedRulesSeen();
    const output = { output: "int main() {}" };
    const appended = appendScopedRules(
      { tool: "read", sessionID: "s1", args: { filePath: "/repo/src/main.c" } },
      output,
      "/repo",
      entries,
      seen,
    );
    expect(appended).toBe(true);
    expect(output.output).toStartWith("int main() {}\n\n");
    expect(output.output).toContain('<project_rules scope="src/main.c">');
    expect(output.output).toContain("Braces.");
    expect(output.output).not.toContain("Always.");

    const again = { output: "other" };
    expect(
      appendScopedRules(
        { tool: "read", sessionID: "s1", args: { filePath: "/repo/src/b.c" } },
        again,
        "/repo",
        entries,
        seen,
      ),
    ).toBe(false);
    expect(again.output).toBe("other");
  });

  test("a different session sees the rule again", () => {
    const seen = createScopedRulesSeen();
    const read = (sessionID: string) =>
      appendScopedRules(
        { tool: "read", sessionID, args: { filePath: "/repo/src/main.c" } },
        { output: "" },
        "/repo",
        entries,
        seen,
      );
    expect(read("s1")).toBe(true);
    expect(read("s2")).toBe(true);
  });

  test("ignores other tools, missing paths, and non-matching files", () => {
    const seen = createScopedRulesSeen();
    const out = { output: "x" };
    expect(
      appendScopedRules(
        { tool: "write", args: { filePath: "/repo/src/main.c" } },
        out,
        "/repo",
        entries,
        seen,
      ),
    ).toBe(false);
    expect(
      appendScopedRules(
        { tool: "read", args: {} },
        out,
        "/repo",
        entries,
        seen,
      ),
    ).toBe(false);
    expect(
      appendScopedRules(
        { tool: "read", args: { filePath: "/repo/README.md" } },
        out,
        "/repo",
        entries,
        seen,
      ),
    ).toBe(false);
    expect(out.output).toBe("x");
  });
});
