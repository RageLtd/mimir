import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "./changes";
import { coverageCheck, sanityCheck, testCounts } from "./checks";

const file = (
  overrides: Partial<ChangedFile> & { path: string },
): ChangedFile => ({
  status: "M",
  added: "",
  removed: "",
  before: "",
  after: "",
  ...overrides,
});

describe("coverageCheck", () => {
  test("source changed, no test touched → block naming the files", () => {
    const failure = coverageCheck([
      file({ path: "src/a.ts", added: "export const a = 1;" }),
      file({ path: "README.md", added: "docs" }),
    ]);
    expect(failure?.check).toBe("coverage");
    expect(failure?.reason).toContain("src/a.ts");
    expect(failure?.reason).not.toContain("README.md");
  });

  test("a changed test file satisfies coverage", () => {
    expect(
      coverageCheck([
        file({ path: "src/a.ts", added: "x" }),
        file({
          path: "src/a.test.ts",
          added: 'test("a", () => { expect(1).toBe(1); });',
        }),
      ]),
    ).toBeNull();
  });

  test("an inline Rust test in the diff satisfies coverage", () => {
    expect(
      coverageCheck([
        file({
          path: "src/lib.rs",
          added:
            "pub fn add() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert!(true); }\n}",
        }),
      ]),
    ).toBeNull();
  });

  test("only docs/config changed → nothing to cover", () => {
    expect(coverageCheck([file({ path: "README.md", added: "x" })])).toBeNull();
    expect(
      coverageCheck([file({ path: "package.json", added: "x" })]),
    ).toBeNull();
  });

  test("a deleted source file alone does not demand a test", () => {
    expect(
      coverageCheck([file({ path: "src/old.ts", status: "D", after: null })]),
    ).toBeNull();
  });

  test("a test file committed earlier on the branch satisfies coverage", () => {
    expect(
      coverageCheck(
        [file({ path: "src/a.ts", added: "x" })],
        ["src/a.test.ts"],
      ),
    ).toBeNull();
  });

  test("non-test paths on the branch do not satisfy coverage", () => {
    expect(
      coverageCheck(
        [file({ path: "src/a.ts", added: "x" })],
        ["src/b.ts", "README.md"],
      )?.check,
    ).toBe("coverage");
  });
});

describe("sanityCheck", () => {
  test("skip marker added → block", () => {
    const failure = sanityCheck([
      file({ path: "a.test.ts", added: 'test.skip("x", () => {});' }),
    ]);
    expect(failure?.reason).toContain("skip");
  });

  test("assertions removed net → block", () => {
    const failure = sanityCheck([
      file({
        path: "a.test.ts",
        added: 'test("x", () => {});',
        removed: 'test("x", () => { expect(1).toBe(1); expect(2).toBe(2); });',
      }),
    ]);
    expect(failure?.reason).toContain("assertions removed");
  });

  test("new test file with tests but no assertions → block", () => {
    const failure = sanityCheck([
      file({
        path: "b.test.ts",
        status: "A",
        before: null,
        added: 'test("nothing", () => { doThing(); });',
      }),
    ]);
    expect(failure?.reason).toContain("no assertions");
  });

  test("deleted test file → block", () => {
    const failure = sanityCheck([
      file({ path: "gone_test.go", status: "D", after: null }),
    ]);
    expect(failure?.reason).toContain("deleted");
  });

  test("healthy test change passes", () => {
    expect(
      sanityCheck([
        file({
          path: "a.test.ts",
          added: 'test("y", () => { expect(y()).toBe(2); });',
          removed: "",
        }),
        file({ path: "src/a.ts", added: "export const y = () => 2;" }),
      ]),
    ).toBeNull();
  });
});

describe("testCounts", () => {
  test("counts test functions before and after across files", () => {
    expect(
      testCounts([
        file({
          path: "a.test.ts",
          before: 'test("a", () => {});',
          after: 'test("a", () => {});\ntest("b", () => {});',
        }),
        file({ path: "lib.rs", before: null, after: "#[test]\nfn x() {}" }),
        file({ path: "README.md", before: "test(", after: "test(\ntest(" }),
      ]),
    ).toEqual({ before: 1, after: 3 });
  });
});
