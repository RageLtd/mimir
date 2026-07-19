import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRules } from "./loader";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rules-loader-"));
  await fs.mkdir(path.join(projectRoot, ".claude"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

const writeRule = async (relativePath: string, contents: string) => {
  const abs = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
  return abs;
};

describe("loadRules — discovery", () => {
  test("returns empty when no .enforce.toml files present", async () => {
    const result = await loadRules(projectRoot);
    expect(result.rules).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("globs every .enforce.toml under .claude/", async () => {
    await writeRule(
      ".claude/rules/coding/a.enforce.toml",
      `id = "coding/a"
event = "file"
[[conditions]]
field = "new_text"
operator = "regex_match"
pattern = "AAA"
`,
    );
    await writeRule(
      ".claude/enforcement/b.enforce.toml",
      `id = "b"
event = "bash"
[[conditions]]
field = "command"
operator = "contains"
pattern = "rm -rf"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors).toHaveLength(0);
    expect(result.rules.map((r) => r.id).sort()).toEqual(["b", "coding/a"]);
  });
});

describe("loadRules — body resolution", () => {
  test("resolves body relative to the .toml's directory", async () => {
    await writeRule(".claude/rules/coding/x.md", "# X rule body\nstuff");
    await writeRule(
      ".claude/rules/coding/x.enforce.toml",
      `id = "coding/x"
body = "./x.md"
event = "file"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "BAD"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors).toHaveLength(0);
    expect(result.rules[0]?.bodyContent).toContain("X rule body");
    expect(result.rules[0]?.body).toBe(
      path.join(projectRoot, ".claude/rules/coding/x.md"),
    );
  });

  test("missing body produces a LoadError (fail loudly)", async () => {
    await writeRule(
      ".claude/rules/coding/x.enforce.toml",
      `id = "coding/x"
body = "./missing.md"
event = "file"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "x"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.rules).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe("coding/x");
    expect(result.errors[0]?.message).toContain("body file unreadable");
  });

  test("absent body is fine", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "bash"
message = "self-contained rule"
[[conditions]]
field = "command"
operator = "contains"
pattern = "rm"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors).toHaveLength(0);
    expect(result.rules[0]?.body).toBeUndefined();
    expect(result.rules[0]?.bodyContent).toBeUndefined();
  });
});

describe("loadRules — validation", () => {
  test("missing id → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `event = "file"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "x"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.rules).toHaveLength(0);
    expect(result.errors[0]?.message).toContain("missing required `id`");
  });

  test("invalid event → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "nope"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "x"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("invalid `event`");
  });

  test("invalid operator → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "file"
[[conditions]]
field = "new_text"
operator = "magic"
pattern = "x"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("invalid `operator`");
  });

  test("invalid regex → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "file"
[[conditions]]
field = "new_text"
operator = "regex_match"
pattern = "a(b"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("regex invalid");
  });

  test("rule with neither detector nor conditions → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "file"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("must declare either");
  });

  test("rule with both detector and conditions → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "file"
detector = "builtin:file-length"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "x"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("cannot declare both");
  });

  test("unknown builtin detector → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `id = "x"
event = "file"
detector = "builtin:does-not-exist"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("unknown detector");
  });

  test("malformed TOML → LoadError", async () => {
    await writeRule(
      ".claude/rules/x.enforce.toml",
      `this is not valid toml = = =`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors[0]?.message).toContain("TOML parse failed");
  });

  test("duplicate id across files → second is dropped with LoadError", async () => {
    await writeRule(
      ".claude/rules/a.enforce.toml",
      `id = "shared"
event = "file"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "A"
`,
    );
    await writeRule(
      ".claude/rules/b.enforce.toml",
      `id = "shared"
event = "file"
[[conditions]]
field = "new_text"
operator = "contains"
pattern = "B"
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.rules).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("duplicate rule id");
  });
});

describe("loadRules — happy path with the engine fixtures", () => {
  test("loads a builtin file-length rule with detector_args", async () => {
    await writeRule(
      ".claude/rules/quality/file-length.enforce.toml",
      `id = "quality/file-length"
event = "file"
detector = "builtin:file-length"
detector_args = { limit = 500 }
`,
    );
    const result = await loadRules(projectRoot);
    expect(result.errors).toHaveLength(0);
    expect(result.rules[0]?.detector).toBe("builtin:file-length");
    expect(result.rules[0]?.detectorArgs).toEqual({ limit: 500 });
  });
});
