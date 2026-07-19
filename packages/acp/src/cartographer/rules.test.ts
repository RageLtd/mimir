import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRulesForPrompt, readProjectRules } from "./rules";

const TMP = join(import.meta.dir, ".tmp-rules-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readProjectRules", () => {
  test("returns empty array when no rules files exist", async () => {
    const entries = await readProjectRules(TMP);
    expect(entries).toEqual([]);
  });

  test("reads CLAUDE.md from project root", async () => {
    writeFileSync(join(TMP, "CLAUDE.md"), "# Rules\nNo OOP.");
    const entries = await readProjectRules(TMP);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("CLAUDE.md");
    expect(entries[0]?.content).toBe("# Rules\nNo OOP.");
  });

  test("reads .cursorrules from project root", async () => {
    writeFileSync(join(TMP, ".cursorrules"), "Use functional style.");
    const entries = await readProjectRules(TMP);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(".cursorrules");
  });

  test("reads AGENTS.md from project root", async () => {
    writeFileSync(join(TMP, "AGENTS.md"), "Agent rules here.");
    const entries = await readProjectRules(TMP);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("AGENTS.md");
  });

  test("reads files from .claude/rules/ recursively", async () => {
    const rulesDir = join(TMP, ".claude/rules/quality");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "standards.md"), "No empty catches.");
    writeFileSync(join(TMP, ".claude/rules/workflow.md"), "Plan first.");

    const entries = await readProjectRules(TMP);
    expect(entries).toHaveLength(2);

    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual([
      ".claude/rules/quality/standards.md",
      ".claude/rules/workflow.md",
    ]);
  });

  test("skips empty files", async () => {
    writeFileSync(join(TMP, "CLAUDE.md"), "");
    writeFileSync(join(TMP, ".cursorrules"), "  \n  ");
    const entries = await readProjectRules(TMP);
    expect(entries).toEqual([]);
  });

  test("reads all sources in one call", async () => {
    writeFileSync(join(TMP, "CLAUDE.md"), "Root rules.");
    writeFileSync(join(TMP, ".cursorrules"), "Cursor rules.");
    const rulesDir = join(TMP, ".claude/rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "extra.md"), "Extra rules.");

    const entries = await readProjectRules(TMP);
    expect(entries).toHaveLength(3);
  });
});

describe("formatRulesForPrompt", () => {
  test("returns null for empty entries", () => {
    expect(formatRulesForPrompt([])).toBeNull();
  });

  test("wraps entries in project_rules XML", () => {
    const result = formatRulesForPrompt([
      { path: "CLAUDE.md", content: "No OOP." },
      { path: ".claude/rules/style.md", content: "Functional only." },
    ]);

    expect(result).toContain("<project_rules>");
    expect(result).toContain("</project_rules>");
    expect(result).toContain("--- CLAUDE.md ---");
    expect(result).toContain("No OOP.");
    expect(result).toContain("--- .claude/rules/style.md ---");
    expect(result).toContain("Functional only.");
  });
});
