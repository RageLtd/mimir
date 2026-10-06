import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "./loader";
import { runRules } from "./runner";

let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "rules-scoping-"));
  await mkdir(join(projectPath, ".claude/rules"), { recursive: true });
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

const loadScopedRule = async (
  frontmatter: string,
  detector = `[[conditions]]
field = "new_text"
operator = "regex_match"
pattern = '(?:^|\\n)(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+[A-Z]\\w*\\b'`,
) => {
  await writeFile(
    join(projectPath, ".claude/rules/style.md"),
    `${frontmatter}# Style\nNo classes.\n`,
  );
  await writeFile(
    join(projectPath, ".claude/rules/style.enforce.toml"),
    `id = "coding/style"
body = "./style.md"
event = "file"
exclude_globs = ["*.d.ts"]
${detector}
`,
  );
  const loaded = await loadRules(projectPath);
  expect(loaded.errors).toEqual([]);
  expect(loaded.rules).toHaveLength(1);
  return loaded.rules;
};

const editInput = (toolName: string, text: string) => {
  switch (toolName) {
    case "Edit":
      return { old_string: "class Segment(NamedTuple):", new_string: text };
    case "Write":
      return { content: text };
    case "MultiEdit":
      return {
        edits: [{ old_string: "class Segment(NamedTuple):", new_string: text }],
      };
    default:
      throw new Error(`unexpected tool: ${toolName}`);
  }
};

describe("enforcement inherits Markdown paths", () => {
  test.each([
    '---\npaths: ["*.ts", "*.tsx"]\ntools: ["Edit", "Write"]\n---\n',
    '---\npaths:\n  - "*.ts"\n  - "*.tsx"\n---\n',
  ])("loads and strips frontmatter: %s", async (frontmatter) => {
    const rules = await loadScopedRule(frontmatter);
    expect(rules[0]?.paths).toEqual(["*.ts", "*.tsx"]);
    expect(rules[0]?.bodyContent).toBe("# Style\nNo classes.");
  });

  test.each([
    "Edit",
    "Write",
    "MultiEdit",
  ])("%s ignores Python classes but still detects nested TypeScript classes", async (toolName) => {
    const rules = await loadScopedRule(
      '---\npaths: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.mjs", "*.rs", "*.go"]\n---\n',
    );
    for (const filePath of [
      "analyzer/minstrel_analyzer/analyze.py",
      join(projectPath, "analyzer/minstrel_analyzer/store.py"),
      "src/types.d.ts",
    ]) {
      expect(
        await runRules(rules, {
          projectPath,
          toolName,
          toolInput: {
            file_path: filePath,
            ...editInput(toolName, "class SongSource(Protocol):"),
          },
        }),
      ).toEqual([]);
    }
    for (const filePath of [
      "src/song.ts",
      "./src/song.tsx",
      join(projectPath, "src/song.ts"),
    ]) {
      expect(
        await runRules(rules, {
          projectPath,
          toolName,
          toolInput: {
            file_path: filePath,
            ...editInput(toolName, "class SongSource {}"),
          },
        }),
      ).toHaveLength(1);
    }
  });

  test("directory patterns are project-relative, not basename matches", async () => {
    const rules = await loadScopedRule('---\npaths: ["src/**/*.ts"]\n---\n');
    for (const [filePath, count] of [
      ["src/song.ts", 1],
      [join(projectPath, "src/nested/song.ts"), 1],
      ["other/src/song.ts", 0],
      ["song.ts", 0],
    ] as const) {
      expect(
        await runRules(rules, {
          projectPath,
          toolName: "Edit",
          toolInput: { path: filePath, new_string: "class SongSource {}" },
        }),
      ).toHaveLength(count);
    }
  });

  test("scope gates builtin detectors too", async () => {
    const rules = await loadScopedRule(
      '---\npaths: ["*.ts"]\n---\n',
      'detector = "builtin:file-length"\ndetector_args = { limit = 1 }',
    );
    for (const [filePath, count] of [
      ["notes.md", 0],
      ["src/song.ts", 1],
    ] as const) {
      expect(
        await runRules(rules, {
          projectPath,
          toolName: "Write",
          toolInput: { file_path: filePath, content: "one\ntwo\nthree" },
        }),
      ).toHaveLength(count);
    }
  });

  test("scoped rules require a target; unscoped rules retain existing behavior", async () => {
    const ctx = {
      projectPath,
      toolName: "Edit",
      toolInput: { new_string: "class SongSource {}" },
    };
    expect(
      await runRules(await loadScopedRule('---\npaths: ["*.ts"]\n---\n'), ctx),
    ).toEqual([]);
    const rules = await loadScopedRule("");
    expect(rules[0]?.paths).toBeUndefined();
    expect(await runRules(rules, ctx)).toHaveLength(1);
    expect(
      await runRules(rules, {
        ...ctx,
        toolInput: { ...ctx.toolInput, file_path: "store.py" },
      }),
    ).toHaveLength(1);
  });
});
