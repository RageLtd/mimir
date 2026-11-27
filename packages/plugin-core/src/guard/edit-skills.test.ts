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
});

describe("editing a source file", () => {
  test.each(SOURCE_FILES)("%s is refused without code-comments", (path) => {
    expect(editSkillDecision(path, []).allow).toBe(false);
  });

  test("the refusal says to load code-comments and then retry the edit", () => {
    const reason = refusal(editSkillDecision("/repo/pkg/sync/client.go", []));
    expect(reason).toContain("code-comments");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test.each(
    SOURCE_FILES,
  )("%s is allowed once code-comments is loaded", (path) => {
    expect(editSkillDecision(path, ["code-comments"])).toEqual({ allow: true });
  });

  test("a plugin-qualified code-comments counts as loaded", () => {
    expect(
      editSkillDecision("/repo/crates/core/src/lib.rs", [
        "mimir-cc:code-comments",
      ]),
    ).toEqual({ allow: true });
  });

  test("unit-testing does not satisfy a source file", () => {
    expect(
      editSkillDecision("/repo/src/brain/extract.ts", ["unit-testing"]).allow,
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
  )("%s is refused with only code-comments loaded", (path) => {
    expect(editSkillDecision(path, ["code-comments"], REFACTOR).allow).toBe(
      false,
    );
  });

  test.each(SOURCE_FILES)("%s is refused with nothing loaded", (path) => {
    expect(editSkillDecision(path, [], REFACTOR).allow).toBe(false);
  });

  test("the refusal says to load refactor and then retry the edit", () => {
    const reason = refusal(
      editSkillDecision(
        "/repo/pkg/sync/client.go",
        ["code-comments"],
        REFACTOR,
      ),
    );
    expect(reason).toContain("refactor");
    expect(reason).toMatch(/\bload\b/i);
    expect(reason).toMatch(/\bretry\b/i);
  });

  test("refactor alone does not stand in for code-comments", () => {
    expect(
      editSkillDecision("/repo/src/brain/extract.ts", ["refactor"], REFACTOR)
        .allow,
    ).toBe(false);
  });

  test.each(
    SOURCE_FILES,
  )("%s is allowed once code-comments and refactor are loaded", (path) => {
    expect(
      editSkillDecision(path, ["code-comments", "refactor"], REFACTOR),
    ).toEqual({ allow: true });
  });

  test("a plugin-qualified refactor counts as loaded", () => {
    expect(
      editSkillDecision(
        "/repo/crates/core/src/lib.rs",
        ["mimir-cc:code-comments", "mimir-cc:refactor"],
        REFACTOR,
      ),
    ).toEqual({ allow: true });
  });

  test.each(OTHER_FILES)("%s still needs no skill", (path) => {
    expect(editSkillDecision(path, [], REFACTOR)).toEqual({ allow: true });
  });

  test("outside a refactor task a source file needs only code-comments", () => {
    expect(
      editSkillDecision("/repo/app/models.py", ["code-comments"], {
        refactor: false,
      }),
    ).toEqual({ allow: true });
  });
});
