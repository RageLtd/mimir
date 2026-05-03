import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRulesGeneratePrompt,
  findOrphanedRuleBodies,
} from "./rules-generate";
import { parseCommand } from "./session";

let rulesDir: string;

beforeEach(async () => {
  rulesDir = await fs.mkdtemp(path.join(os.tmpdir(), "rules-gen-"));
});

afterEach(async () => {
  await fs.rm(rulesDir, { recursive: true, force: true });
});

const writeFile = async (relativePath: string, contents: string) => {
  const abs = path.join(rulesDir, relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
  return abs;
};

describe("findOrphanedRuleBodies", () => {
  test("returns empty when no .md files present", async () => {
    expect(await findOrphanedRuleBodies(rulesDir)).toEqual([]);
  });

  test("returns .md files lacking a sibling .enforce.toml", async () => {
    const orphan = await writeFile(
      "coding/no-any.md",
      "# No any\n\nDon't use `any`.",
    );
    await writeFile(
      "coding/return-types.md",
      "# Return types\n\nLet TS infer.",
    );
    await writeFile(
      "coding/return-types.enforce.toml",
      'id = "coding/return-types"\nevent = "file"\n',
    );

    const result = await findOrphanedRuleBodies(rulesDir);
    expect(result).toEqual([orphan]);
  });

  test("walks nested directories", async () => {
    const a = await writeFile("a/x.md", "x");
    const b = await writeFile("a/b/y.md", "y");
    const result = await findOrphanedRuleBodies(rulesDir);
    expect(result).toEqual([a, b].sort());
  });

  test("ignores non-.md files", async () => {
    await writeFile("notes.txt", "ignore me");
    await writeFile("rule.md", "include me");
    const result = await findOrphanedRuleBodies(rulesDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("rule.md");
  });

  test("returns paths sorted lexicographically", async () => {
    await writeFile("z/last.md", "z");
    await writeFile("a/first.md", "a");
    await writeFile("m/middle.md", "m");
    const result = await findOrphanedRuleBodies(rulesDir);
    // Sort is on full paths, so dir names dominate over basenames:
    // a/first < m/middle < z/last
    const names = result.map((p) => path.basename(p));
    expect(names).toEqual(["first.md", "middle.md", "last.md"]);
  });

  test("pairs by exact basename — `foo.md` and `foo.enforce.toml`", async () => {
    // Sibling pairing must be by basename, not by directory listing
    // alone — confirm a colliding basename in a different dir doesn't
    // accidentally pair.
    const orphan = await writeFile("a/x.md", "a-x");
    await writeFile("b/x.md", "b-x");
    await writeFile(
      "b/x.enforce.toml",
      'id = "b/x"\nevent = "file"\n',
    );
    const result = await findOrphanedRuleBodies(rulesDir);
    expect(result).toEqual([orphan]);
  });
});

describe("buildRulesGeneratePrompt", () => {
  test("includes the schema header", () => {
    const out = buildRulesGeneratePrompt(["/x/a.md"]);
    expect(out).toContain("## Schema");
    expect(out).toContain('event = "<event>"');
    expect(out).toContain("[[conditions]]");
    expect(out).toContain("[[negative_conditions]]");
  });

  test("includes the field vocabulary", () => {
    const out = buildRulesGeneratePrompt(["/x/a.md"]);
    expect(out).toContain("file_path");
    expect(out).toContain("new_text");
    expect(out).toContain("command");
  });

  test("includes builtin detector reference", () => {
    const out = buildRulesGeneratePrompt(["/x/a.md"]);
    expect(out).toContain("builtin:file-length");
  });

  test("instructs the model to skip conceptual rules", () => {
    const out = buildRulesGeneratePrompt(["/x/a.md"]);
    expect(out).toContain("conceptual");
    expect(out).toContain("Skip");
  });

  test("appends the rule list as bullets", () => {
    const out = buildRulesGeneratePrompt([
      "/proj/.claude/rules/coding/a.md",
      "/proj/.claude/rules/safety/b.md",
    ]);
    expect(out).toContain("- /proj/.claude/rules/coding/a.md");
    expect(out).toContain("- /proj/.claude/rules/safety/b.md");
  });
});

describe("parseCommand /rules", () => {
  test("/rules generate parses to rules_generate", () => {
    expect(parseCommand("/rules generate")).toEqual({
      type: "rules_generate",
    });
  });

  test("/rules with unknown sub returns null", () => {
    expect(parseCommand("/rules nonsense")).toBeNull();
  });

  test("/rules without a sub returns null", () => {
    expect(parseCommand("/rules")).toBeNull();
  });

  test("ignores leading whitespace", () => {
    expect(parseCommand("   /rules generate")).toEqual({
      type: "rules_generate",
    });
  });
});
