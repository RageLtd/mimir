import { describe, expect, test } from "bun:test";
import type { GuardDecision } from "./decision";
import { editSkillDecision } from "./edit-skills";

const refusal = (decision: GuardDecision) => {
  if (decision.allow) throw new Error("expected the edit to be refused");
  return decision.reason;
};

const TEST_FILES = [
  "/repo/src/brain/extract.test.ts",
  "/repo/web/Button.spec.tsx",
  "/repo/pkg/sync/client_test.go",
  "/repo/crates/core/tests/round_trip.rs",
  "/repo/app/test_models.py",
];

const SOURCE_FILES = [
  "/repo/src/brain/extract.ts",
  "/repo/web/Button.tsx",
  "/repo/pkg/sync/client.go",
  "/repo/crates/core/src/lib.rs",
  "/repo/app/models.py",
];

const OTHER_FILES = [
  "/repo/README.md",
  "/repo/package.json",
  "/repo/.github/workflows/ci.yaml",
  "/repo/Cargo.toml",
  "/repo/bun.lock",
  "/repo/notes.txt",
  "/repo/Makefile",
];

describe("editing a test file", () => {
  test.each(TEST_FILES)("%s is refused without unit-testing", (path) => {
    expect(editSkillDecision(path, []).allow).toBe(false);
  });

  test("the refusal says to load unit-testing and then retry the edit", () => {
    const reason = refusal(editSkillDecision(TEST_FILES[0] ?? "", []));
    expect(reason).toContain("unit-testing");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test("the refusal names the other testing skills to load when they fit", () => {
    const reason = refusal(editSkillDecision(TEST_FILES[0] ?? "", []));
    expect(reason).toContain("integration-testing");
    expect(reason).toContain("end-to-end-testing");
    expect(reason).toContain("ui-testing");
  });

  test.each(TEST_FILES)("%s is allowed once unit-testing is loaded", (path) => {
    expect(editSkillDecision(path, ["unit-testing"])).toEqual({ allow: true });
  });

  test("a plugin-qualified unit-testing counts as loaded", () => {
    expect(
      editSkillDecision("/repo/pkg/sync/client_test.go", [
        "mimir-cc:unit-testing",
      ]),
    ).toEqual({ allow: true });
  });

  test("code-comments does not satisfy a test file", () => {
    expect(
      editSkillDecision("/repo/app/test_models.py", ["code-comments"]).allow,
    ).toBe(false);
  });

  test("less-code does not satisfy a test file", () => {
    expect(
      editSkillDecision("/repo/app/test_models.py", ["less-code"]).allow,
    ).toBe(false);
  });

  test("a test file needs only unit-testing", () => {
    expect(
      editSkillDecision("/repo/src/brain/extract.test.ts", ["unit-testing"]),
    ).toEqual({ allow: true });
  });
});

describe("editing a source file", () => {
  test.each(SOURCE_FILES)("%s is refused with nothing loaded", (path) => {
    expect(editSkillDecision(path, []).allow).toBe(false);
  });

  test("with nothing loaded one refusal names code-comments and less-code, says to load them and then retry the edit", () => {
    const reason = refusal(editSkillDecision("/repo/pkg/sync/client.go", []));
    expect(reason).toContain("code-comments");
    expect(reason).toContain("less-code");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test("with less-code loaded the refusal names only code-comments", () => {
    const reason = refusal(
      editSkillDecision("/repo/pkg/sync/client.go", ["less-code"]),
    );
    expect(reason).toContain("code-comments");
    expect(reason).not.toContain("less-code");
  });

  test.each(
    SOURCE_FILES,
  )("%s is refused with only code-comments loaded", (path) => {
    expect(editSkillDecision(path, ["code-comments"]).allow).toBe(false);
  });

  test("with code-comments loaded the refusal names only less-code, says to load it and then retry the edit", () => {
    const reason = refusal(
      editSkillDecision("/repo/pkg/sync/client.go", ["code-comments"]),
    );
    expect(reason).toContain("less-code");
    expect(reason).not.toContain("code-comments");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test("less-code alone does not stand in for code-comments", () => {
    expect(
      editSkillDecision("/repo/src/brain/extract.ts", ["less-code"]).allow,
    ).toBe(false);
  });

  test.each(
    SOURCE_FILES,
  )("%s is allowed once code-comments and less-code are loaded", (path) => {
    expect(editSkillDecision(path, ["code-comments", "less-code"])).toEqual({
      allow: true,
    });
  });

  test("plugin-qualified code-comments and less-code count as loaded", () => {
    expect(
      editSkillDecision("/repo/crates/core/src/lib.rs", [
        "mimir-cc:code-comments",
        "mimir-cc:less-code",
      ]),
    ).toEqual({ allow: true });
  });

  test("bare and plugin-qualified names count together", () => {
    expect(
      editSkillDecision("/repo/app/models.py", [
        "code-comments",
        "mimir-cc:less-code",
      ]),
    ).toEqual({ allow: true });
  });

  test("unit-testing does not satisfy a source file", () => {
    expect(
      editSkillDecision("/repo/src/brain/extract.ts", [
        "unit-testing",
        "less-code",
      ]).allow,
    ).toBe(false);
  });
});

describe("editing any other file", () => {
  test.each(OTHER_FILES)("%s needs no skill", (path) => {
    expect(editSkillDecision(path, [])).toEqual({ allow: true });
  });
});

describe("an implementer's edit in a refactor task", () => {
  const REFACTOR = { refactor: true };

  test.each(
    SOURCE_FILES,
  )("%s is refused with code-comments and less-code but not refactor loaded", (path) => {
    expect(
      editSkillDecision(path, ["code-comments", "less-code"], REFACTOR).allow,
    ).toBe(false);
  });

  test.each(SOURCE_FILES)("%s is refused with nothing loaded", (path) => {
    expect(editSkillDecision(path, [], REFACTOR).allow).toBe(false);
  });

  test("with nothing loaded one refusal names code-comments, less-code and refactor", () => {
    const reason = refusal(
      editSkillDecision("/repo/pkg/sync/client.go", [], REFACTOR),
    );
    expect(reason).toContain("code-comments");
    expect(reason).toContain("less-code");
    expect(reason).toContain("refactor");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test("with code-comments and less-code loaded the refusal names only refactor, says to load it and then retry the edit", () => {
    const reason = refusal(
      editSkillDecision(
        "/repo/pkg/sync/client.go",
        ["code-comments", "less-code"],
        REFACTOR,
      ),
    );
    expect(reason).toContain("refactor");
    expect(reason).not.toContain("code-comments");
    expect(reason).not.toContain("less-code");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test("with code-comments loaded the refusal names less-code and refactor, not code-comments", () => {
    const reason = refusal(
      editSkillDecision(
        "/repo/pkg/sync/client.go",
        ["code-comments"],
        REFACTOR,
      ),
    );
    expect(reason).toContain("less-code");
    expect(reason).toContain("refactor");
    expect(reason).not.toContain("code-comments");
  });

  test("with code-comments and refactor loaded the refusal names only less-code", () => {
    const reason = refusal(
      editSkillDecision(
        "/repo/pkg/sync/client.go",
        ["code-comments", "refactor"],
        REFACTOR,
      ),
    );
    expect(reason).toContain("less-code");
    expect(reason).not.toContain("code-comments");
  });

  test("with less-code and refactor loaded the refusal names only code-comments", () => {
    const reason = refusal(
      editSkillDecision(
        "/repo/pkg/sync/client.go",
        ["less-code", "refactor"],
        REFACTOR,
      ),
    );
    expect(reason).toContain("code-comments");
    expect(reason).not.toContain("less-code");
  });

  test("refactor alone does not stand in for code-comments or less-code", () => {
    expect(
      editSkillDecision("/repo/src/brain/extract.ts", ["refactor"], REFACTOR)
        .allow,
    ).toBe(false);
  });

  test.each(
    SOURCE_FILES,
  )("%s is allowed once code-comments, less-code and refactor are loaded", (path) => {
    expect(
      editSkillDecision(
        path,
        ["code-comments", "less-code", "refactor"],
        REFACTOR,
      ),
    ).toEqual({ allow: true });
  });

  test("plugin-qualified names count as loaded", () => {
    expect(
      editSkillDecision(
        "/repo/crates/core/src/lib.rs",
        ["mimir-cc:code-comments", "mimir-cc:less-code", "mimir-cc:refactor"],
        REFACTOR,
      ),
    ).toEqual({ allow: true });
  });

  test("a test file still needs only unit-testing", () => {
    expect(
      editSkillDecision("/repo/app/test_models.py", ["unit-testing"], REFACTOR),
    ).toEqual({ allow: true });
  });

  test.each(OTHER_FILES)("%s still needs no skill", (path) => {
    expect(editSkillDecision(path, [], REFACTOR)).toEqual({ allow: true });
  });

  test("outside a refactor task a source file needs code-comments and less-code, not refactor", () => {
    expect(
      editSkillDecision("/repo/app/models.py", ["code-comments", "less-code"], {
        refactor: false,
      }),
    ).toEqual({ allow: true });
  });
});
