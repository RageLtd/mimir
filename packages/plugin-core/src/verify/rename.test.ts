/**
 * A moved test file is not a deleted one: the collector pairs the old path
 * with the new one from what git reports and what is on disk, and the
 * checks judge the pair as an edit. Git's answers are canned, so no command
 * runs; whether git would report a given move as a rename is not checked
 * here.
 */

import { describe, expect, test } from "bun:test";
import {
  cannedGit,
  gateSandbox,
  TASK_BASE,
} from "./change-fixtures.test-helpers";
import { collectChanges } from "./changes";
import { sanityCheck, testCounts } from "./checks";

const OLD_PATH = "src/widget/format.test.ts";
const NEW_PATH = "src/format/format.test.ts";
const DELETED = "test file deleted";
const ORIGINAL_TESTS = 12;
const HEAD = "c".repeat(40);

/** One realistic test: a setup line, a call, two assertions. */
const testCase = (i: number, assertions = 2) => {
  const lines = [
    `  test("formats case ${i}", () => {`,
    `    const input = { id: ${i}, label: "item-${i}", tags: ["a", "b"] };`,
    `    const out = format(input);`,
    `    expect(out.id).toBe(${i});`,
    `    expect(out.label).toBe("ITEM-${i}");`,
    "  });",
    "",
  ];
  return assertions >= 2
    ? lines.join("\n")
    : lines.filter((l) => !l.includes("out.label")).join("\n");
};

const testFile = (
  count: number,
  { comment = "// Formatting rules.", weakened = 0 } = {},
) =>
  [
    'import { describe, expect, test } from "bun:test";',
    'import { format } from "./format";',
    "",
    comment,
    'describe("format", () => {',
    ...Array.from({ length: count }, (_, i) =>
      testCase(i + 1, i < weakened ? 1 : 2),
    ),
    "});",
    "",
  ].join("\n");

/** A different suite: other names, other bodies, three assertions each. */
const rewrittenFile = (count: number) =>
  [
    'import { describe, expect, test } from "bun:test";',
    'import { format, parse } from "./format";',
    "",
    'describe("format round-trip", () => {',
    ...Array.from({ length: count }, (_, i) =>
      [
        `  test("round-trips record ${i + 1} with nested fields", () => {`,
        `    const record = { key: "k${i + 1}", nested: { depth: ${i + 1}, flags: [true, false] } };`,
        "    const text = format(record);",
        "    const back = parse(text);",
        `    expect(typeof text).toBe("string");`,
        `    expect(back.key).toBe("k${i + 1}");`,
        `    expect(back.nested.depth).toBe(${i + 1});`,
        "  });",
        "",
      ].join("\n"),
    ),
    "});",
    "",
  ].join("\n");

const ORIGINAL = testFile(ORIGINAL_TESTS);

const { project } = gateSandbox();

/**
 * The gate's view of a worktree whose base commit held `ORIGINAL` at
 * OLD_PATH. `onDisk` is what the worktree holds now, `nameStatus` is what
 * `git diff --name-status -M` reports against the base, and `untracked`
 * what `git ls-files --others` lists.
 */
const gateOn = async (
  onDisk: Record<string, string>,
  nameStatus: string,
  untracked: readonly string[] = [],
) => {
  const root = await project(onDisk);
  const run = cannedGit({
    "worktree list --porcelain": `worktree ${root}\nHEAD ${HEAD}\n`,
    "rev-parse HEAD": `${HEAD}\n`,
    [`diff --name-status -M ${HEAD}`]: nameStatus,
    "ls-files --others --exclude-standard": untracked.join("\n"),
    [`show ${HEAD}:${OLD_PATH}`]: ORIGINAL,
    [`diff ${HEAD} -- ${OLD_PATH}`]: "",
    [`merge-base ${HEAD} main`]: `${HEAD}\n`,
  });
  const changes = await collectChanges(run, root);
  if (!changes) throw new Error("collectChanges returned null");
  return {
    sanity: sanityCheck(changes.files),
    counts: testCounts(changes.files),
  };
};

describe("verify gate: moved test files", () => {
  test("a rename git reports, content unchanged → no sanity problem, counts N → N", async () => {
    const { sanity, counts } = await gateOn(
      { [NEW_PATH]: ORIGINAL },
      `R100\t${OLD_PATH}\t${NEW_PATH}\n`,
    );
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(sanity).toBeNull();
    expect(counts).toEqual({ before: ORIGINAL_TESTS, after: ORIGINAL_TESTS });
  });

  test("a rename git reports, with four tests added and a comment edited → not a deletion", async () => {
    const { sanity, counts } = await gateOn(
      {
        [NEW_PATH]: testFile(ORIGINAL_TESTS + 4, {
          comment: "// Formatting rules, moved.",
        }),
      },
      `R074\t${OLD_PATH}\t${NEW_PATH}\n`,
    );
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(sanity).toBeNull();
    expect(counts).toEqual({
      before: ORIGINAL_TESTS,
      after: ORIGINAL_TESTS + 4,
    });
  });

  test("a move that drops assertions is still blocked as assertions removed", async () => {
    const { sanity } = await gateOn(
      { [NEW_PATH]: testFile(ORIGINAL_TESTS, { weakened: 3 }) },
      `R090\t${OLD_PATH}\t${NEW_PATH}\n`,
    );
    expect(sanity?.reason).toContain("assertions removed");
    expect(sanity?.reason).not.toContain(DELETED);
  });

  test("a test file deleted outright is still reported as deleted", async () => {
    const { sanity, counts } = await gateOn({}, `D\t${OLD_PATH}\n`);
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
    expect(counts).toEqual({ before: ORIGINAL_TESTS, after: 0 });
  });

  test("an unstaged move with identical content → treated like a reported rename", async () => {
    const { sanity, counts } = await gateOn(
      { [NEW_PATH]: ORIGINAL },
      `D\t${OLD_PATH}\n`,
      [NEW_PATH],
    );
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(sanity).toBeNull();
    expect(counts).toEqual({ before: ORIGINAL_TESTS, after: ORIGINAL_TESTS });
  });

  test("a move git pairs only against HEAD, the file rewritten since an older task base → not a deletion, counts from the base", async () => {
    const root = await project({ [NEW_PATH]: rewrittenFile(16) });
    // Against the task base the two files are too different for git to
    // pair; against HEAD, where the rewrite is committed, it does.
    const run = cannedGit({
      [`cat-file -e ${TASK_BASE}^{commit}`]: "",
      [`merge-base --is-ancestor ${TASK_BASE} HEAD`]: "",
      [`diff --name-status -M ${TASK_BASE}`]: `D\t${OLD_PATH}\nA\t${NEW_PATH}\n`,
      "ls-files --others --exclude-standard": "",
      "rev-parse HEAD": `${HEAD}\n`,
      "diff --name-status -M HEAD": `R081\t${OLD_PATH}\t${NEW_PATH}\n`,
      [`show ${TASK_BASE}:${OLD_PATH}`]: testFile(4),
    });

    const changes = await collectChanges(run, root, TASK_BASE);
    if (!changes) throw new Error("collectChanges returned null");
    expect(sanityCheck(changes.files)?.reason ?? "").not.toContain(DELETED);
    expect(testCounts(changes.files)).toEqual({ before: 4, after: 16 });
  });
});

/** Not a test path under the TS convention: no `.test`/`.spec`, no `tests/` dir. */
const FIXTURE_PATH = "src/widget/format.fixture.ts";
const OTHER_PATH = "src/other/format.test.ts";

describe("verify gate: moves the pairing must not accept", () => {
  test("a rename git reports to a non-test path → still a deleted test", async () => {
    const { sanity } = await gateOn(
      { [FIXTURE_PATH]: ORIGINAL },
      `R100\t${OLD_PATH}\t${FIXTURE_PATH}\n`,
    );
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
  });

  test("an unstaged move to a non-test path → still a deleted test", async () => {
    const { sanity } = await gateOn(
      { [FIXTURE_PATH]: ORIGINAL },
      `D\t${OLD_PATH}\n`,
      [FIXTURE_PATH],
    );
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
  });

  test("one deleted test file, two untracked identical copies → paired once, counts N → 2N", async () => {
    const { sanity, counts } = await gateOn(
      { [NEW_PATH]: ORIGINAL, [OTHER_PATH]: ORIGINAL },
      `D\t${OLD_PATH}\n`,
      [NEW_PATH, OTHER_PATH],
    );
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(counts).toEqual({
      before: ORIGINAL_TESTS,
      after: ORIGINAL_TESTS * 2,
    });
  });

  test("an unstaged move with content edited → reported as deleted, with a hint to stage the move", async () => {
    const { sanity } = await gateOn(
      { [NEW_PATH]: testFile(ORIGINAL_TESTS + 4) },
      `D\t${OLD_PATH}\n`,
      [NEW_PATH],
    );
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
    expect(sanity?.reason).toMatch(/git (add|mv)/);
  });
});
