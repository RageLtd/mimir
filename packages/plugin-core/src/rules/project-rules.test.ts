import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatRulesForPrompt,
  formatScopedRules,
  parseRuleFile,
  readProjectRules,
  scopedRulesFor,
} from "./project-rules";

const TMP = join(import.meta.dir, ".tmp-project-rules-test");
const rulesDir = join(TMP, ".claude/rules");

beforeEach(() => {
  mkdirSync(rulesDir, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readProjectRules", () => {
  test("returns [] when the project has no rules files", async () => {
    rmSync(rulesDir, { recursive: true, force: true });
    expect(await readProjectRules(TMP)).toEqual([]);
  });

  test("reads the three root files and the rules directory, sorted", async () => {
    writeFileSync(join(TMP, "CLAUDE.md"), "Root rules.");
    writeFileSync(join(TMP, ".cursorrules"), "Cursor rules.");
    writeFileSync(join(TMP, "AGENTS.md"), "Agent rules.");
    mkdirSync(join(rulesDir, "quality"), { recursive: true });
    writeFileSync(join(rulesDir, "quality/standards.md"), "No empty catches.");
    writeFileSync(join(rulesDir, "workflow.md"), "Plan first.");

    const entries = await readProjectRules(TMP);
    expect(entries.map((e) => e.path)).toEqual([
      "CLAUDE.md",
      ".cursorrules",
      "AGENTS.md",
      ".claude/rules/quality/standards.md",
      ".claude/rules/workflow.md",
    ]);
    expect(entries[0]?.content).toBe("Root rules.");
  });

  test("a CLAUDE.md symlinked to AGENTS.md is read once", async () => {
    writeFileSync(join(TMP, "AGENTS.md"), "Canonical.");
    symlinkSync("AGENTS.md", join(TMP, "CLAUDE.md"));
    const entries = await readProjectRules(TMP);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("CLAUDE.md");
    expect(entries[0]?.content).toBe("Canonical.");
  });

  test("includeRootFiles: false yields only the rules directory", async () => {
    writeFileSync(join(TMP, "AGENTS.md"), "Agent rules.");
    writeFileSync(join(rulesDir, "style.md"), "Functional only.");
    const entries = await readProjectRules(TMP, { includeRootFiles: false });
    expect(entries.map((e) => e.path)).toEqual([".claude/rules/style.md"]);
  });

  test("skips empty files and frontmatter-only files", async () => {
    writeFileSync(join(TMP, "CLAUDE.md"), "  \n ");
    writeFileSync(join(rulesDir, "empty.md"), "---\npaths: ['*.c']\n---\n");
    expect(await readProjectRules(TMP)).toEqual([]);
  });

  test("strips frontmatter and records paths for scoped rules", async () => {
    writeFileSync(
      join(rulesDir, "braces.md"),
      '---\npaths: ["*.c", "*.h"]\ntools: ["Edit"]\n---\n# Braces\nAlways.',
    );
    writeFileSync(
      join(rulesDir, "api.md"),
      "---\npaths:\n  - 'src/api/**/*.ts'\n  - \"lib/**/*.ts\"\n---\nValidate input.",
    );
    writeFileSync(join(rulesDir, "plain.md"), "Always on.");

    const entries = await readProjectRules(TMP);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath[".claude/rules/braces.md"]).toEqual({
      path: ".claude/rules/braces.md",
      content: "# Braces\nAlways.",
      paths: ["*.c", "*.h"],
    });
    expect(byPath[".claude/rules/api.md"]?.paths).toEqual([
      "src/api/**/*.ts",
      "lib/**/*.ts",
    ]);
    expect(byPath[".claude/rules/plain.md"]?.paths).toBeUndefined();
  });
});

describe("parseRuleFile", () => {
  test("frontmatter without paths is always-on, body kept", () => {
    expect(parseRuleFile("---\ntools: [Edit]\n---\nBody.")).toEqual({
      body: "Body.",
      paths: undefined,
    });
  });

  test("no frontmatter passes the text through trimmed", () => {
    expect(parseRuleFile("\nJust text.\n")).toEqual({
      body: "Just text.",
      paths: undefined,
    });
  });
});

describe("formatRulesForPrompt", () => {
  test("returns null for no entries", () => {
    expect(formatRulesForPrompt([])).toBeNull();
  });

  test("wraps always-on entries and leaves scoped ones out", () => {
    const block = formatRulesForPrompt([
      { path: "AGENTS.md", content: "No OOP." },
      { path: ".claude/rules/c.md", content: "Braces.", paths: ["*.c"] },
    ]);
    expect(block).toContain("<project_rules>");
    expect(block).toContain("--- AGENTS.md ---\nNo OOP.");
    expect(block).not.toContain("Braces.");
  });

  test("returns null when every entry is scoped", () => {
    expect(
      formatRulesForPrompt([
        { path: ".claude/rules/c.md", content: "Braces.", paths: ["*.c"] },
      ]),
    ).toBeNull();
  });
});

describe("scopedRulesFor", () => {
  const entries = [
    { path: "AGENTS.md", content: "Always." },
    { path: ".claude/rules/c.md", content: "Braces.", paths: ["*.c", "*.h"] },
    {
      path: ".claude/rules/api.md",
      content: "Validate.",
      paths: ["src/api/**/*.ts"],
    },
    {
      path: ".claude/rules/ts.md",
      content: "Types.",
      paths: ["**/*.{ts,tsx}"],
    },
  ];

  test("bare patterns match the basename at any depth (Claude Code behaviour)", () => {
    expect(scopedRulesFor(entries, "main.c").map((e) => e.path)).toEqual([
      ".claude/rules/c.md",
    ]);
    expect(
      scopedRulesFor(entries, "src/deep/nested/main.c").map((e) => e.path),
    ).toEqual([".claude/rules/c.md"]);
    expect(scopedRulesFor(entries, "src/main.cpp")).toEqual([]);
  });

  test("patterns with a slash are anchored to the relative path", () => {
    const paths = scopedRulesFor(entries, "src/api/users.ts").map(
      (e) => e.path,
    );
    expect(paths).toEqual([".claude/rules/api.md", ".claude/rules/ts.md"]);
    expect(scopedRulesFor(entries, "./lib/x.tsx").map((e) => e.path)).toEqual([
      ".claude/rules/ts.md",
    ]);
    // Anchored pattern must not match by basename alone.
    expect(
      scopedRulesFor(entries, "other/users.ts").map((e) => e.path),
    ).toEqual([".claude/rules/ts.md"]);
  });

  test("always-on entries never match as scoped", () => {
    expect(scopedRulesFor(entries, "AGENTS.md")).toEqual([]);
  });

  test("formatScopedRules renders the matched block or null", () => {
    expect(formatScopedRules(entries, "README.md")).toBeNull();
    const block = formatScopedRules(entries, "main.c");
    expect(block).toContain('<project_rules scope="main.c">');
    expect(block).toContain("Braces.");
    expect(block).not.toContain("Always.");
  });
});
