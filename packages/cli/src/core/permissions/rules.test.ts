import { describe, expect, test } from "bun:test";
import {
  eligibleForAlways,
  isCompound,
  matchesAny,
  matchesRule,
  type PermissionRequest,
  parseRules,
  ruleFor,
  stringifyRules,
  summarize,
} from "./rules.ts";

const bash = (command: string, id = "t1"): PermissionRequest => ({
  id,
  toolName: "Bash",
  input: { command },
});
const read = (file_path: string): PermissionRequest => ({
  id: "t2",
  toolName: "Read",
  input: { file_path },
});

describe("isCompound", () => {
  test("simple commands are not compound", () => {
    expect(isCompound("git status")).toBe(false);
    expect(isCompound("ls -la 'a b'")).toBe(false);
  });

  test.each([
    "ls | head",
    "a && b",
    "a || b",
    "a; b",
    "sleep 1 &",
    "echo `date`",
    "echo $(date)",
    "a\nb",
  ])("%j is compound", (command) => {
    expect(isCompound(command)).toBe(true);
  });
});

describe("eligibleForAlways / ruleFor", () => {
  test("simple bash → exact-command rule", () => {
    expect(eligibleForAlways(bash("git status"))).toBe(true);
    expect(ruleFor(bash(" git status "))).toEqual({
      tool: "Bash",
      command: "git status",
    });
  });

  test("compound bash → not eligible, no rule", () => {
    expect(eligibleForAlways(bash("ls | head"))).toBe(false);
    expect(ruleFor(bash("ls | head"))).toBeUndefined();
  });

  test("non-bash tools → tool-wide rule", () => {
    expect(eligibleForAlways(read("a.ts"))).toBe(true);
    expect(ruleFor(read("a.ts"))).toEqual({ tool: "Read" });
  });
});

describe("matchesRule", () => {
  test("bash rule matches only the exact command", () => {
    const rule = { tool: "Bash", command: "git status" };
    expect(matchesRule(rule, bash("git status"))).toBe(true);
    expect(matchesRule(rule, bash("git status "))).toBe(true);
    expect(matchesRule(rule, bash("git status --short"))).toBe(false);
    expect(matchesRule(rule, bash("git status | cat"))).toBe(false);
  });

  test("tool-wide rule never covers bash", () => {
    expect(matchesRule({ tool: "Bash" }, bash("rm -rf /"))).toBe(false);
    expect(matchesRule({ tool: "Read" }, read("x"))).toBe(true);
    expect(matchesRule({ tool: "Read" }, bash("cat x"))).toBe(false);
  });

  test("matchesAny over a list", () => {
    const rules = [{ tool: "Read" }, { tool: "Bash", command: "bun test" }];
    expect(matchesAny(rules, bash("bun test"))).toBe(true);
    expect(matchesAny(rules, bash("bun run build"))).toBe(false);
  });
});

describe("summarize", () => {
  test("prefers command, then path-like keys, then truncated JSON", () => {
    expect(summarize(bash("git status"))).toBe("git status");
    expect(summarize(read("/tmp/x"))).toBe("/tmp/x");
    const long = { id: "t3", toolName: "X", input: { blob: "a".repeat(300) } };
    expect(summarize(long).length).toBeLessThanOrEqual(201);
    expect(summarize(long).endsWith("…")).toBe(true);
  });
});

describe("rules file", () => {
  test("round-trips", () => {
    const rules = [{ tool: "Read" }, { tool: "Bash", command: "bun test" }];
    expect(parseRules(stringifyRules(rules))[1]).toEqual(rules);
  });

  test("empty document → no rules", () => {
    expect(parseRules("")[1]).toEqual([]);
  });

  test("validation errors are located", () => {
    const error = (text: string) => parseRules(text)[0]?.message ?? "";
    expect(error("[[allow]]\ncommand = 'x'\n")).toBe(
      "allow[0].tool: expected a string",
    );
    expect(error("[[allow]]\ntool = 'Bash'\ncommand = 1\n")).toBe(
      "allow[0].command: expected a string",
    );
    expect(error("allow = 1\n")).toBe("allow: expected an array of tables");
    expect(error("[[allow")).toStartWith("malformed TOML");
  });
});
